import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiError, rateLimited } from "@/lib/api-errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyNudge } from "@/lib/nudge-verify-service";

export const dynamic = "force-dynamic";

/**
 * The customer-facing half of Verified Nudge.
 *
 * Public and unauthenticated by necessity: the person who needs it is
 * holding a message they do not trust, and any sign-in step is one a phishing
 * site can imitate more convincingly than this can defend. So the only things
 * standing between it and an attacker are the ones inside it — a 40-bit code
 * space, a per-code attempt cap, and a shared rate limiter.
 *
 * Note the two guards here fail in opposite directions, deliberately. The
 * limiter fails open, because the harm it prevents is load and refusing
 * during a blip would break the check for everyone to avoid a hypothetical
 * spike. The verification fails closed, because answering "verified" without
 * having checked tells someone a phishing message is genuine. Neither
 * polarity is a default; each is a judgement about what the failure costs.
 */

function safeDb() {
  try {
    return getDb();
  } catch {
    // Unset DATABASE_URL. The service turns this into `unavailable`, which is
    // the honest answer, rather than into "no such payment".
    return null;
  }
}

/**
 * Who to count against the limit.
 *
 * Trivially spoofable, and that is fine: the per-code attempt cap is what
 * actually bounds guessing, and it cannot be evaded by changing an address.
 * This exists to make enumeration expensive, not to be an identity.
 */
function caller(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: Request) {
  const limit = await enforceRateLimit(`verify:${caller(req)}`, 20, 60_000, safeDb());
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  let body: { code?: string; amount?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_body", 400);
  }

  const outcome = await verifyNudge(
    { code: body.code, amount: body.amount },
    { db: safeDb(), now: () => new Date() }
  );

  /**
   * A refusal is not an error. A customer being told their message is
   * unrecognised has received the answer they came for, and returning 4xx for
   * it would put the single most important result of this feature into the
   * client's error path.
   *
   * The response carries nothing beyond the verdict. On a match it names the
   * merchant and echoes the amount the customer already supplied; on
   * everything else it says only what happened. Returning the payment details
   * on the code alone would build the oracle this design exists to avoid.
   */
  if (outcome.status === "unavailable") {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }

  return NextResponse.json(outcome);
}
