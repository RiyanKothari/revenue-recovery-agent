import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Without this Next prerenders this handler at build time and the dashboard
// polls a frozen snapshot forever.
export const dynamic = "force-dynamic";

/**
 * Everything the dashboard's batch summary card needs, computed from the
 * real tables — no numbers invented client-side.
 */
export async function GET() {
  const { data: events } = await supabase
    .from("revenue_events")
    .select("id, amount_paise, root_cause, received_at, processed_at");

  const { data: outcomes } = await supabase
    .from("outcomes")
    .select("revenue_event_id, recovered, recovered_amount_paise, resolved_at");

  const { data: auditExceptions } = await supabase
    .from("audit_log")
    .select("revenue_event_id, detail")
    .eq("stage", "stopping_rule_triggered");

  const totalAtRiskPaise = (events ?? []).reduce((s, e) => s + e.amount_paise, 0);
  const recoveredEvents = (outcomes ?? []).filter((o) => o.recovered);
  const recoveredPaise = recoveredEvents.reduce(
    (s, o) => s + (o.recovered_amount_paise ?? 0),
    0
  );

  const byRootCause: Record<string, { count: number; amount_paise: number }> = {};
  for (const e of events ?? []) {
    const key = e.root_cause ?? "unclassified";
    byRootCause[key] ??= { count: 0, amount_paise: 0 };
    byRootCause[key].count += 1;
    byRootCause[key].amount_paise += e.amount_paise;
  }

  const avgTimeToRecoveryMinutes =
    recoveredEvents.length > 0
      ? recoveredEvents.reduce((sum, o) => {
          const event = events?.find((e) => e.id === o.revenue_event_id);
          if (!event || !o.resolved_at) return sum;
          const mins =
            (new Date(o.resolved_at).getTime() - new Date(event.received_at).getTime()) /
            60000;
          return sum + mins;
        }, 0) / recoveredEvents.length
      : null;

  return NextResponse.json({
    total_events: events?.length ?? 0,
    total_at_risk_paise: totalAtRiskPaise,
    recovered_paise: recoveredPaise,
    recovery_rate: events?.length ? recoveredEvents.length / events.length : 0,
    by_root_cause: byRootCause,
    avg_time_to_recovery_minutes: avgTimeToRecoveryMinutes,
    exceptions: (auditExceptions ?? []).map((e) => ({
      revenue_event_id: e.revenue_event_id,
      reason: (e.detail as any)?.reason,
    })),
  });
}
