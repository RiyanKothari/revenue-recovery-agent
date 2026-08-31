import { NextResponse } from "next/server";
import { runConformance } from "@/lib/conformance-store";

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
  } catch (err: any) {
    return NextResponse.json(
      { error: "conformance_failed", detail: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
