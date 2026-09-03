import { NextResponse } from "next/server";
import { runConformance } from "@/lib/conformance-store";
import { apiError } from "@/lib/api-errors";

// Recomputed per request from live tables — a cached conformance result is
// worse than none, since it would attest to a state that may no longer hold.
export const dynamic = "force-dynamic";

/**
 * Machine-checked proof that the safety rules held, plus what they cost.
 *
 * Powers the dashboard's conformance panel. Fails loudly rather than
 * returning a partial result: a verifier that degrades quietly into "no
 * violations found" because a query failed is actively dangerous.
 */
export async function GET() {
  try {
    const bundle = await runConformance();
    return NextResponse.json(bundle);
  } catch (err) {
    return apiError("conformance_failed", 500, err);
  }
}
