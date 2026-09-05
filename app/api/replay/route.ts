import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiError, rateLimited } from "@/lib/api-errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { DEFAULT_POLICY, type RecoveryPolicy } from "@/lib/policy";
import {
  comparePolicies,
  compareToRecorded,
  replayPolicy,
  type ReplayDisposition,
  type ReplayEvent,
} from "@/lib/replay";
import { estimateRecoveryProbability } from "@/lib/propensity";
import { getObservedStats } from "@/lib/propensity-store";

export const dynamic = "force-dynamic";

/**
 * How many events one replay will read into memory.
 *
 * Sized so the whole working set stays well inside a serverless function's
 * limit with room for the joins built on top of it. Raising it is a decision
 * about memory, not about correctness — the engine is indifferent.
 */
const MAX_REPLAY_EVENTS = 20_000;

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
  /**
   * This reads every event, decision, action and outcome in the batch and
   * re-runs the gates over all of them. It is public and idempotent, so the
   * exposure is not data — it is that anyone can ask a deployed instance to
   * do that repeatedly at the database's expense. Twenty a minute is far
   * more than the Policy Lab's slider needs and far less than a loop wants.
   */
  let db;
  try {
    db = getDb();
  } catch (err) {
    return apiError("database_unavailable", 503, err);
  }

  // Counted in the database, not in module memory — see lib/rate-limit.ts for
  // why the per-process version was measured to do almost nothing here.
  const limit = await enforceRateLimit("replay", 20, 60_000, db);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  let body: ReplayRequest = {};
  try {
    body = (await request.json()) ?? {};
  } catch {
    // An empty body means "replay the current policy against itself", which
    // is a useful no-op: it proves the engine reproduces the live run.
    body = {};
  }

  try {
    /**
     * Bounded, and the bound is reported.
     *
     * This loads whole tables into one lambda's memory. That is correct at
     * this project's volume and wrong at six figures, where it would be an
     * out-of-memory kill rather than a slow response. A counterfactual is an
     * estimate, so truncating it is legitimate in a way that truncating the
     * conformance verifier is not — but only if the reader is told, which is
     * what `scope` in the response is for.
     */
    const totalEvents = await db.countEvents();
    const truncated = totalEvents > MAX_REPLAY_EVENTS;

    const [events, consent, decisions, actions, assignments, outcomes] = await Promise.all([
      db.listEvents(truncated ? MAX_REPLAY_EVENTS : undefined),
      db.listConsent(),
      db.listDecisions(),
      db.listRecoveryActions(),
      db.listAssignments(),
      db.listOutcomes(),
    ]);

    // Stopping rules, for the fidelity check below.
    const stops = await db.listStoppingRules();

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

    /**
     * What actually happened, per event, in the replay engine's own
     * vocabulary — so the engine can be pointed at the policy that really ran
     * and checked against the record. A counterfactual tool that cannot
     * reproduce the past has no business predicting an alternative one, and
     * "the gates are deterministic" is an argument, not evidence.
     */
    const RECORDED_DISPOSITIONS: Record<string, ReplayDisposition> = {
      customer_dnd_opt_out: "blocked_dnd",
      max_retry_attempts_reached: "blocked_retry_ceiling",
      cooldown_window_active: "blocked_cooldown",
      negative_expected_value: "declined_negative_ev",
      holdout_control: "holdout_control",
    };

    const recorded = new Map<string, string>();
    for (const stop of stops) {
      // First stop wins, matching how the pipeline halts.
      const mapped = RECORDED_DISPOSITIONS[stop.reason];
      if (mapped && !recorded.has(stop.revenue_event_id)) {
        recorded.set(stop.revenue_event_id, mapped);
      }
    }
    // An event that reached a decision without stopping was acted on.
    for (const decision of decisions) {
      if (!recorded.has(decision.revenue_event_id)) {
        recorded.set(decision.revenue_event_id, "acted");
      }
    }

    const fidelity = compareToRecorded(
      replayPolicy(replayEvents, DEFAULT_POLICY),
      recorded
    );

    const candidate = clampPolicy(body);
    const comparison = comparePolicies(
      replayEvents,
      DEFAULT_POLICY,
      candidate,
      observedArms
    );

    return NextResponse.json({
      events_replayed: replayEvents.length,
      scope: {
        events_total: totalEvents,
        events_examined: replayEvents.length,
        truncated,
        note: truncated
          ? `Replayed the ${MAX_REPLAY_EVENTS} most recent events of ${totalEvents}. A counterfactual over a suffix of history is still a counterfactual, but it is not the whole batch and the comparison below should be read as covering that window.`
          : "The whole recorded batch.",
      },
      candidate_policy: {
        holdoutPercent: candidate.holdoutPercent,
        minExpectedValuePaise: candidate.minExpectedValuePaise,
        cooldownMinutes: candidate.cooldownMinutes,
        maxRetryAttempts: candidate.maxRetryAttempts,
      },
      ...comparison,

      /**
       * How faithfully the engine reproduces the run that actually happened.
       * Published alongside every counterfactual so the reader can weigh the
       * prediction by the engine's demonstrated accuracy rather than by
       * assertion.
       */
      fidelity,
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
  } catch (err) {
    return apiError("replay_failed", 500, err);
  }
}
