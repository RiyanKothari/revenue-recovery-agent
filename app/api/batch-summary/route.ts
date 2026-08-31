import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { computeLift, type ArmOutcome } from "@/lib/experiment";
import { DEFAULT_POLICY } from "@/lib/policy";

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
  const [eventsRes, outcomesRes, exceptionsRes, decisionsRes, assignmentsRes] =
    await Promise.all([
    supabase
      .from("revenue_events")
      .select("id, amount_paise, root_cause, received_at, processed_at"),
    supabase
      .from("outcomes")
      .select("revenue_event_id, recovered, recovered_amount_paise, resolved_at"),
    supabase
      .from("audit_log")
      .select("revenue_event_id, detail")
      .eq("stage", "stopping_rule_triggered"),
    // Events the agent actually acted on, for an attempted-only rate.
    supabase.from("agent_decisions").select("revenue_event_id"),
      supabase.from("experiment_assignments").select("revenue_event_id, arm"),
    ]);

  const failed =
    eventsRes.error ??
    outcomesRes.error ??
    exceptionsRes.error ??
    decisionsRes.error ??
    assignmentsRes.error;

  if (failed) {
    return NextResponse.json(
      { error: "summary_query_failed", detail: failed.message },
      { status: 500 }
    );
  }

  const events = eventsRes.data ?? [];
  const outcomes = outcomesRes.data ?? [];
  const auditExceptions = exceptionsRes.data ?? [];
  const decisions = decisionsRes.data ?? [];

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
  const attemptedEventIds = new Set(decisions.map((d) => d.revenue_event_id));
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
  const assignments = assignmentsRes.data ?? [];
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
      reason: (e.detail as any)?.reason,
    })),
  });
}
