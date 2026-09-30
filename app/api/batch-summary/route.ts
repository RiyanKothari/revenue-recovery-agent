import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiError } from "@/lib/api-errors";
import { assessPower } from "@/lib/experiment";
import { collectDeliveryStates, measureWithDelivery } from "@/lib/delivery-attrition";
import { DEFAULT_POLICY } from "@/lib/policy";
import { bucketOutcomes } from "@/lib/outcome-buckets";
import { armSeries, causePerformance, dailySeries } from "@/lib/analytics";

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
  let events, outcomes, auditExceptions, decisionEventIds, assignments, deliveryEvidence;

  try {
    const db = getDb();
    [events, outcomes, auditExceptions, decisionEventIds, assignments, deliveryEvidence] =
      await Promise.all([
        db.listEvents(),
        db.listOutcomes(),
        db.listStoppingRules(),
        // Events the agent actually acted on, for an attempted-only rate.
        db.listDecisionEventIds(),
        db.listAssignments(),
        // What the provider later said about each message — see below.
        db.listDeliveryEvidence(),
      ]);
  } catch (err) {
    return apiError("summary_query_failed", 500, err);
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

  /**
   * The arms are built by the delivery-aware measurement rather than here,
   * so the headline lift and the delivery breakdown cannot disagree about
   * the denominator. `intentionToTreat` is the arms exactly as assigned —
   * the same numbers this route computed inline before — and the module adds
   * the second reading, on the messages the provider confirmed arrived.
   *
   * That second reading is the point. `recovery_actions.delivery_state` has
   * been populated by Meta's authenticated delivery callback since it was
   * built, and nothing has ever read it back: every figure on this dashboard
   * treated an accepted send as a nudge received. See lib/delivery-attrition.ts
   * for why the fix is to report both numbers rather than to quietly prefer
   * the flattering one.
   */
  const delivery = measureWithDelivery({
    assignments: assignments.map((a) => ({
      revenueEventId: a.revenue_event_id,
      arm: a.arm,
    })),
    deliveryStates: collectDeliveryStates(deliveryEvidence),
    recoveredPaiseByEvent: recoveredById,
  });

  const arms = delivery.intentionToTreat;
  const lift = arms.lift;

  /**
   * Whether this experiment could have detected the effect at all. Without
   * it "not significant" reads as "the agent did not work" when it usually
   * means the holdout was never large enough to tell.
   */
  const power = assessPower(arms.treated, arms.control);

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

  /**
   * The two questions the ledger cannot answer: is this getting better over
   * time, and which failure types repay the effort. Both became answerable
   * only once events carried real arrival times spread across a week.
   */
  const analyticsInput = {
    events: events.map((e) => ({
      id: e.id,
      amountPaise: e.amount_paise,
      rootCause: e.root_cause,
      receivedAt: e.received_at,
    })),
    recoveredIds: new Set(recoveredEvents.map((o) => o.revenue_event_id)),
    armByEvent: new Map(assignments.map((a) => [a.revenue_event_id, a.arm])),
  };

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

    daily: dailySeries(analyticsInput),
    by_cause_performance: causePerformance(analyticsInput),
    arm_series: armSeries(analyticsInput),

    // Measured causal impact, not attribution.
    experiment: {
      policy_version: DEFAULT_POLICY.version,
      holdout_percent: DEFAULT_POLICY.holdoutPercent,
      treated: arms.treated,
      control: arms.control,
      lift,
      power,
    },

    /**
     * The same lift, read twice: as assigned, and among the customers a
     * message provably reached. `intention_to_treat` above is the claimable
     * number; this says how much of it undelivered messages are eating.
     */
    delivery: {
      evidence_coverage: delivery.evidenceCoverage,
      attrition: delivery.attrition,
      per_protocol_status: delivery.perProtocolStatus,
      per_protocol: delivery.perProtocol && {
        treated: delivery.perProtocol.treated,
        control: delivery.perProtocol.control,
        lift: delivery.perProtocol.lift,
      },
      delivery_cost_pp: delivery.deliveryCostPp,
      reading: delivery.reading,
      caveat: delivery.caveat,
    },
    exceptions: auditExceptions.map((e) => ({
      revenue_event_id: e.revenue_event_id,
      reason: e.reason,
    })),
  });
}
