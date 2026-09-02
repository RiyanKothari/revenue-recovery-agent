import crypto from "crypto";

/**
 * Verifies a Razorpay webhook signature.
 * Razorpay signs the raw request body with your webhook secret (HMAC-SHA256)
 * and sends it in the `x-razorpay-signature` header. Never trust a webhook
 * whose signature doesn't match — that's the one non-negotiable check in
 * this whole pipeline.
 */
export function verifyRazorpaySignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined
): boolean {
  if (!signature) return false;

  /**
   * A missing or empty secret is a refusal, not a key.
   *
   * This is the sharpest edge in the whole project. `createHmac("sha256", "")`
   * does not throw — it happily computes a perfectly valid HMAC using an
   * empty key. So if RAZORPAY_WEBHOOK_SECRET is unset or blank, every
   * signature check still runs, still looks rigorous, and passes for anyone
   * who can compute an HMAC with a key that is public knowledge. That is a
   * complete authentication bypass on the only entry point to the pipeline,
   * and it fails silently in the most dangerous direction: an attacker could
   * post fabricated payment failures and have the agent create real payment
   * links and send real WhatsApp messages.
   *
   * The .env.local template ships this variable blank, so "unconfigured" is
   * the default state rather than an exotic one — which is precisely why this
   * has to be checked here, at the point of use, rather than trusted to
   * deployment discipline.
   *
   * An undefined secret would throw instead, which at least fails closed, but
   * it throws before the route's error handling and returns an empty-bodied
   * 500. Both cases collapse to the same honest answer: unverifiable.
   */
  if (!secret) {
    console.error(
      "[verify-webhook] RAZORPAY_WEBHOOK_SECRET is not set — refusing every webhook. An empty secret would otherwise accept forged signatures."
    );
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison — don't use `===` for signatures.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
