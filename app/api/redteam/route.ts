import { NextResponse } from "next/server";
import { runRedTeam } from "@/lib/redteam";
import { apiError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * Runs the hostile-input suite against the live defences.
 *
 * Read-only: every attack here is either refused before it can write, or
 * demonstrated against the pure function that would have refused it. A safety
 * demonstration that pollutes the audit trail it is vouching for has defeated
 * its own purpose.
 */
export async function GET() {
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
