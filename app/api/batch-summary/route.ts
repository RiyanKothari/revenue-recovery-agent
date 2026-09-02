import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeLift, type ArmOutcome } from "@/lib/experiment";
import { DEFAULT_POLICY } from "@/lib/policy";
import { bucketOutcomes } from "@/lib/outcome-buckets";

// Without this Next prerenders this handler at build time and the dashboard
// polls a frozen snapshot forever.
export const dynamic = "force-dynamic";

/**
 * Everything the dashboard's batch summary card needs, computed from the
 * real tables — no numbers invented client-side.
 *
 * Query failures return 500 rather than falling through with empty arrays.
 * Dropping `error` here produced a dashboard reading "0 recovered, 0.0%",
 * which is indistinguishable from a working agent that recovered nothing —
 * the most misleading thing this screen could show. The dashboard keeps its
 * last good numbers on a non-200, so an outage looks like staleness rather
 * than failure.
 */
export async function GET() {
  let events, outcomes, auditExceptions, decisionEventIds, assignments;

  try {
    const db = getDb();
    [events, outcomes, auditExceptions, decisionEventIds, assignments] = await Promise.all([
      db.listEvents(),
      db.listOutcomes(),
      db.listStoppingRules(),
      // Events the agent actually acted on, for an attempted-only rate.
      db.listDecisionEventIds(),
      db.listAssignments(),
    ]);
  } catch (err: any) {
    return NextResponse.json(
      { error: "summary_query_failed", detail: err?.message ?? "unknown" },
      { status: 500 }
    );
  }

  const totalAtRiskPaise = events.reduce((s, e) => s + e.amount_paise, 0);
  const recoveredEvents = outcomes.filter((o) => o.recovered);
  const recoveredPaise = recoveredEvents.reduce(
    (s, o) => s + (o.recovered_amount_paise ?? 0),
    0
  );

  const byRootCause: Record<string, { count: number; amount_paise: number }> = {};
  for (const e of events) {
    const key = e.root_cause ?? "unclassified";
    byRootCause[key] ??= { count: 0, amount_paise: 0 };
    byRootCause[key].count += 1;
    byRootCause[key].amount_paise += e.amount_paise;
  }

  // Average over the recoveries we can actually time. The previous version
  // skipped entries missing an event row or resolved_at inside the reducer
  // but still divided by the full recovered count, understating the average
  // by however many it had skipped.
  const receivedAtById = new Map(events.map((e) => [e.id, e.received_at]));
  const durationsMinutes = recoveredEvents.flatMap((o) => {
    const receivedAt = receivedAtById.get(o.revenue_event_id);
    if (!receivedAt || !o.resolved_at) return [];
    return [
      (new Date(o.resolved_at).getTime() - new Date(receivedAt).getTime()) / 60000,
    ];
  });

  const avgTimeToRecoveryMinutes = durationsMinutes.length
    ? durationsMinutes.reduce((s, m) => s + m, 0) / durationsMinutes.length
    : null;

  // Two rates, because they answer different questions. The overall rate is
  // the business number (of everything that failed, how much came back). The
  // attempted rate is the agent's number, excluding events it deliberately
  // never touched — unknown root causes routed straight to human review.
  const attemptedEventIds = new Set(decisionEventIds);
  const recoveredAttempted = recoveredEvents.filter((o) =>
    attemptedEventIds.has(o.revenue_event_id)
  ).length;

  /**
   * Measured lift. This is the number the whole holdout exists for: of the
   * events that were both allowed and worth acting on, a slice was left
   * untreated, and the gap between the arms is the recovery the agent can
   * actually claim to have caused. Everything above this line is attribution;
   * this is measurement.
   */

  const recoveredById = new Map(
    recoveredEvents.map((o) => [o.revenue_event_id, o.recovered_amount_paise ?? 0])
  );

  const arms: Record<"treated" | "control", ArmOutcome> = {
    treated: { n: 0, converted: 0, recoveredPaise: 0 },
    control: { n: 0, converted: 0, recoveredPaise: 0 },
  };

  for (const assignment of assignments) {
    const arm = assignment.arm === "control" ? "control" : "treated";
    arms[arm].n += 1;

    const recovered = recoveredById.get(assignment.revenue_event_id);
    if (recovered !== undefined) {
      arms[arm].converted += 1;
      arms[arm].recoveredPaise += recovered;
    }
  }

  const lift = computeLift(arms.treated, arms.control);

  /**
   * Whether this batch is synthetic, so the dashboard can say so.
   *
   * Synthetic recoveries are generated from a stated assumption (see
   * scripts/generate-synthetic-batch.ts), which means the lift below measures
   * an effect the batch was told to have. That is a legitimate demonstration
   * of the measurement machinery and an illegitimate claim about the agent —
   * the difference has to be visible on screen, not buried in a README.
   */
  const syntheticEvents = events.filter((e) =>
    (e.razorpay_order_id ?? "").startsWith("order_synthetic_")
  ).length;

  /**
   * Where the money went, in rupees. The exception list below answers "which
   * events stopped and why"; this answers "how much of the batch ended up in
   * each outcome", which is the question the hero renders and the one a
   * payments team actually asks. Counting events instead would report a batch
   * that blocked 35 small failures and recovered three large ones as mostly
   * blocked, when the money says the opposite.
   */
  const outcomeBuckets = bucketOutcomes({
    events: events.map((e) => ({ id: e.id, amount_paise: e.amount_paise })),
    recovered: recoveredEvents.map((o) => ({
      revenue_event_id: o.revenue_event_id,
      recovered_amount_paise: o.recovered_amount_paise,
    })),
    stops: auditExceptions,
  });

  return NextResponse.json({
    total_events: events.length,
    total_at_risk_paise: totalAtRiskPaise,
    recovered_paise: recoveredPaise,
    recovery_rate: events.length ? recoveredEvents.length / events.length : 0,
    attempted_events: attemptedEventIds.size,
    recovery_rate_attempted: attemptedEventIds.size
      ? recoveredAttempted / attemptedEventIds.size
      : 0,
    by_root_cause: byRootCause,
    avg_time_to_recovery_minutes: avgTimeToRecoveryMinutes,
    timed_recoveries: durationsMinutes.length,

    synthetic_events: syntheticEvents,

    // Rupee partition of the batch — see bucketOutcomes for the ordering rule.
    outcome_buckets: outcomeBuckets.buckets,

    // Measured causal impact, not attribution.
    experiment: {
      policy_version: DEFAULT_POLICY.version,
      holdout_percent: DEFAULT_POLICY.holdoutPercent,
      treated: arms.treated,
      control: arms.control,
      lift,
    },
    exceptions: auditExceptions.map((e) => ({
      revenue_event_id: e.revenue_event_id,
      reason: e.reason,
    })),
  });
}
