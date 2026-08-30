import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyRazorpaySignature } from "../lib/verify-webhook";

/**
 * Signature verification is the one non-negotiable check in the pipeline —
 * without it anyone who knows the URL can inject fake revenue events and
 * drive real WhatsApp sends. These cases cover the ways it must refuse.
 */

const SECRET = "test_webhook_secret";
const BODY = JSON.stringify({
  event: "payment.failed",
  payload: { payment: { entity: { id: "pay_test_1", amount: 50000 } } },
});

function sign(body: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("accepts a correctly signed body", () => {
  assert.equal(verifyRazorpaySignature(BODY, sign(BODY), SECRET), true);
});

test("rejects a body that was tampered with after signing", () => {
  const signature = sign(BODY);
  const tampered = BODY.replace('"amount":50000', '"amount":1');

  assert.equal(verifyRazorpaySignature(tampered, signature, SECRET), false);
});

test("rejects a signature produced with the wrong secret", () => {
  const forged = sign(BODY, "attacker_guessed_secret");

  assert.equal(verifyRazorpaySignature(BODY, forged, SECRET), false);
});

test("rejects a missing signature header", () => {
  assert.equal(verifyRazorpaySignature(BODY, null, SECRET), false);
});

// timingSafeEqual throws if the two buffers differ in length, so the
// length guard has to run first — a short signature must return false,
// not blow up the route with a 500.
test("rejects a malformed short signature without throwing", () => {
  assert.equal(verifyRazorpaySignature(BODY, "abc123", SECRET), false);
});

test("rejects an empty signature without throwing", () => {
  assert.equal(verifyRazorpaySignature(BODY, "", SECRET), false);
});
