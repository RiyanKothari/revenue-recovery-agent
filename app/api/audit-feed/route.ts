import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Without this Next prerenders this handler at build time and the "live"
// feed never advances past the build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * Powers the dashboard's live feed — this is the "wow" moment from the
 * blueprint: the agent's reasoning visible in near-real-time, not just a
 * final tally. Joins audit_log back to the decision + event so each row
 * can render root cause, action, and rationale together.
 */
export async function GET() {
  const { data: logs } = await supabase
    .from("audit_log")
    .select("id, revenue_event_id, stage, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  const eventIds = [...new Set((logs ?? []).map((l) => l.revenue_event_id))];

  const { data: events } = await supabase
    .from("revenue_events")
    .select("id, amount_paise, root_cause, customer_id")
    .in("id", eventIds.length ? eventIds : ["00000000-0000-0000-0000-000000000000"]);

  const eventMap = new Map((events ?? []).map((e) => [e.id, e]));

  const feed = (logs ?? []).map((log) => ({
    ...log,
    event: eventMap.get(log.revenue_event_id) ?? null,
  }));

  return NextResponse.json({ feed });
}
