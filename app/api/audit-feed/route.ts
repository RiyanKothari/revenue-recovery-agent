import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Without this Next prerenders this handler at build time and the "live"
// feed never advances past the build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * Powers the dashboard's live feed — the agent's reasoning visible in
 * near-real-time, not just a final tally. Joins audit_log back to the event
 * so each row can render root cause, amount, and rationale together.
 *
 * Errors must not degrade into an empty feed. Returning { feed: [] } with a
 * 200 was worse than failing: the dashboard's !res.ok guard passed, so a
 * transient database error would clear the reasoning panel mid-demo and read
 * as "the agent has done nothing".
 */
export async function GET() {
  try {
    const db = getDb();
    // Only the stages the feed renders. Asking for "the last 100 rows" and
    // filtering client-side meant a finished batch showed an empty feed.
    const logs = await db.listRecentAudit(60, ["agent_decided", "action_executed"]);

    const eventIds = [...new Set(logs.map((l) => l.revenue_event_id))];
    const events = await db.listEventsByIds(eventIds);
    const eventMap = new Map(events.map((e) => [e.id, e]));

    const feed = logs.map((log) => ({
      ...log,
      event: eventMap.get(log.revenue_event_id) ?? null,
    }));

    return NextResponse.json({ feed });
  } catch (err: any) {
    return NextResponse.json(
      { error: "audit_feed_query_failed", detail: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
