import { NextResponse } from "next/server";
import { runRedTeam } from "@/lib/redteam";
import { apiError, rateLimited } from "@/lib/api-errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The shared counter, or nothing.
 *
 * `getDb()` throws when DATABASE_URL is unset, and the red team suite is the
 * one endpoint that must still run in that state — half its value is showing
 * what happens when the database is unavailable. A limiter that prevents the
 * outage demo from running during an outage has its priorities backwards.
 */
function safeDb() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

/**
 * Runs the hostile-input suite against the live defences.
 *
 * Read-only: every attack here is either refused before it can write, or
 * demonstrated against the pure function that would have refused it. A safety
 * demonstration that pollutes the audit trail it is vouching for has defeated
 * its own purpose.
 */
export async function GET() {
  /**
   * Counted in the database rather than in module memory, because module
   * memory is per-lambda: thirty-four requests against a limit of thirty all
   * returned 200 in production before this changed. See lib/rate-limit.ts.
   */
  const limit = await enforceRateLimit("redteam", 30, 60_000, safeDb());
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  try {
    const results = await runRedTeam(process.env.RAZORPAY_WEBHOOK_SECRET);
    const held = results.filter((r) => r.blocked).length;

    return NextResponse.json({
      results,
      total: results.length,
      held,
      // Reported plainly. A defence that regressed must show as breached
      // rather than be quietly dropped from the count.
      breached: results.length - held,
    });
  } catch (err) {
    return apiError("redteam_failed", 500, err);
  }
}
