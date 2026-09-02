import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DEFAULT_POLICY, type RecoveryPolicy } from "@/lib/policy";
import { comparePolicies, type ReplayEvent } from "@/lib/replay";
import { estimateRecoveryProbability } from "@/lib/propensity";
import { getObservedStats } from "@/lib/propensity-store";

export const dynamic = "force-dynamic";

/**
 * The Policy Lab. Re-runs recorded history under a different policy and
 * reports what would have changed.
 *
 * Read-only by construction: it calls no model, contacts nobody, and writes
 * nothing. Everything before the model in this pipeline is deterministic and
 * every input it read was written down, so the counterfactual is a
 * recomputation rather than a simulation.
 *
 * Only the four tunable knobs are accepted. A policy is not passed through
 * wholesale from a request body — `dndRespected` is typed as a literal `true`
 * precisely so consent cannot be relaxed, and accepting an arbitrary object
 * here would route around that guarantee through the one door that takes
 * outside input.
 */
interface ReplayRequest {
  holdoutPercent?: number;
  minExpectedValuePaise?: number;
  cooldownMinutes?: number;
  maxRetryAttempts?: number;
}

function clampPolicy(body: ReplayRequest): RecoveryPolicy {
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  return {
    ...DEFAULT_POLICY,
    version: "candidate",
    holdoutPercent: num(body.holdoutPercent, DEFAULT_POLICY.holdoutPercent, 0, 100),
    minExpectedValuePaise: num(
      body.minExpectedValuePaise,
      DEFAULT_POLICY.minExpectedValuePaise,
      -100_000_00,
      100_000_00
    ),
    cooldownMinutes: num(body.cooldownMinutes, DEFAULT_POLICY.cooldownMinutes, 0, 60 * 24 * 30),
    maxRetryAttempts: num(body.maxRetryAttempts, DEFAULT_POLICY.maxRetryAttempts, 0, 20),
    dndRespected: true,
  };
}

export async function POST(request: Request) {
  let body: ReplayRequest = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    // An empty body means "replay the current policy against itself", which
    // is a useful no-op: it proves the engine reproduces the live run.
    body = {};
  }

  try {
    const db = getDb();

    const [events, consent, decisions, actions, assignments, outcomes] = await Promise.all([
      db.listEvents(),
      db.listConsent(),
      db.listDecisions(),
      db.listRecoveryActions(),
      db.listAssignments(),
      db.listOutcomes(),
    ]);

    const dndByCustomer = new Map(consent.map((c) => [c.customer_id, c.dnd]));
    const eventIdByDecision = new Map(decisions.map((d) => [d.id, d.revenue_event_id]));
    const customerByEvent = new Map(events.map((e) => [e.id, e.customer_id]));

    /**
     * Contact history per customer, and attempt counts per event, rebuilt
     * from the recovery actions themselves. The cooldown and retry ceiling
     * are questions about what was actually sent, so they have to be answered
     * from the send record rather than from any intermediate tally.
     */
    const attemptsByEvent = new Map<string, number>();
    const contactTimesByCustomer = new Map<string, number[]>();

    for (const action of actions) {
      const eventId = eventIdByDecision.get(action.agent_decision_id);
      if (!eventId) continue;

      attemptsByEvent.set(eventId, (attemptsByEvent.get(eventId) ?? 0) + 1);

      const customerId = customerByEvent.get(eventId);
      if (!customerId) continue;

      const times = contactTimesByCustomer.get(customerId) ?? [];
      times.push(new Date(action.executed_at).getTime());
      contactTimesByCustomer.set(customerId, times);
    }

    const probabilityByEvent = new Map(
      assignments
        .filter((a) => a.recovery_probability !== null)
        .map((a) => [a.revenue_event_id, a.recovery_probability as number])
    );

    /**
     * Events blocked before the arm was assigned have no recorded
     * probability, so it is recomputed the way the pipeline would have — from
     * the observed stats for that root cause. Cached per cause rather than
     * per event: the estimate depends only on the cause, and querying it four
     * hundred times would make the panel unusable.
     */
    const observedByCause = new Map<string, number>();
    for (const event of events) {
      const cause = event.root_cause ?? "unknown";
      if (observedByCause.has(cause)) continue;
      const observed = await getObservedStats(cause);
      observedByCause.set(cause, estimateRecoveryProbability(cause, observed));
    }

    const recoveredById = new Map(
      outcomes
        .filter((o) => o.recovered)
        .map((o) => [o.revenue_event_id, o.recovered_amount_paise ?? 0])
    );

    const replayEvents: ReplayEvent[] = events.map((event) => {
      const customerId = event.customer_id;
      const receivedAt = new Date(event.received_at).getTime();

      // Only contact that happened BEFORE this event counts — a later nudge
      // cannot have been the reason this one was held back.
      const priorContacts = (contactTimesByCustomer.get(customerId ?? "") ?? []).filter(
        (t) => t < receivedAt
      );
      const lastContact = priorContacts.length ? Math.max(...priorContacts) : null;

      const recovered = recoveredById.get(event.id);

      return {
        id: event.id,
        amountPaise: event.amount_paise,
        dnd: customerId ? (dndByCustomer.get(customerId) ?? false) : false,
        recoveryProbability:
          probabilityByEvent.get(event.id) ??
          observedByCause.get(event.root_cause ?? "unknown") ??
          0,
        priorAttempts: attemptsByEvent.get(event.id) ?? 0,
        minutesSinceLastContact:
          lastContact === null ? null : (receivedAt - lastContact) / 60000,
        recovered: recovered !== undefined,
        recoveredPaise: recovered ?? 0,
      };
    });

    // Observed arms, used only to calibrate the recovery estimate against
    // rates this system actually measured rather than an assumed uplift.
    const observedArms = {
      treated: { n: 0, converted: 0, recoveredPaise: 0 },
      control: { n: 0, converted: 0, recoveredPaise: 0 },
    };

    for (const assignment of assignments) {
      const arm = assignment.arm === "control" ? "control" : "treated";
      observedArms[arm].n += 1;
      const recovered = recoveredById.get(assignment.revenue_event_id);
      if (recovered !== undefined) {
        observedArms[arm].converted += 1;
        observedArms[arm].recoveredPaise += recovered;
      }
    }

    const candidate = clampPolicy(body);
    const comparison = comparePolicies(
      replayEvents,
      DEFAULT_POLICY,
      candidate,
      observedArms
    );

    return NextResponse.json({
      events_replayed: replayEvents.length,
      candidate_policy: {
        holdoutPercent: candidate.holdoutPercent,
        minExpectedValuePaise: candidate.minExpectedValuePaise,
        cooldownMinutes: candidate.cooldownMinutes,
        maxRetryAttempts: candidate.maxRetryAttempts,
      },
      ...comparison,
      /**
       * Stated in the payload, not only in the UI. Anything consuming this
       * endpoint has to be able to tell which half is a recomputation and
       * which half rests on an assumption, without reading the dashboard.
       */
      honesty: {
        exact:
          "Which events each policy acts on, holds back, declines as unprofitable, or assigns to the holdout. Pure functions of recorded data.",
        estimated:
          "Recovered rupees. Nobody knows whether a customer who was never contacted would have paid; the estimate applies conversion rates measured on the arms that actually ran.",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "replay_failed", detail: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
