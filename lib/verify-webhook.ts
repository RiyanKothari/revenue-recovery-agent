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
  secret: string
): boolean {
  if (!signature) return false;

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
