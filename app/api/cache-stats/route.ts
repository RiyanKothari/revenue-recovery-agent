import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { summariseCache } from "@/lib/decision-cache";

export const dynamic = "force-dynamic";

/**
 * How many distinct situations the batch actually contained, and how many
 * model calls it took to answer all of them.
 *
 * This is the answer to "does this scale", given as a measurement rather than
 * an assertion — a four-hundred-event batch reduces to a couple of dozen
 * genuinely different decisions, and the ratio is visible on the dashboard
 * instead of being claimed in a README.
 *
 * Computed from the decision rows, not from a counter: a counter records what
 * the code believed it did, and this records what the database can prove.
 */
export async function GET() {
  try {
    const decisions = await getDb().listDecisions();
    return NextResponse.json(summariseCache(decisions));
  } catch (err: any) {
    return NextResponse.json(
      { error: "cache_stats_query_failed", detail: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
