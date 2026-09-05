import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../lib/classifier";

/**
 * The classifier is the deterministic floor the agent reasons within, so it
 * is worth pinning down. Every case below uses an error_description shaped
 * like the ones the synthetic batch generator emits, which are in turn shaped
 * like Razorpay's own payment.failed payloads.
 */

test("maps insufficient funds to a recoverable root cause", () => {
  const result = classify({
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed due to insufficient funds in the account.",
    payment_method: "card",
  });

  assert.equal(result.root_cause, "insufficient_funds");
  assert.equal(result.is_recoverable, true);
  assert.equal(result.payment_method, "card");
});

test("maps a gateway timeout to bank_timeout", () => {
  const result = classify({
    error_code: "GATEWAY_ERROR",
    error_description: "Payment gateway timeout, please try again.",
    payment_method: "netbanking",
  });

  assert.equal(result.root_cause, "bank_timeout");
  assert.equal(result.is_recoverable, true);
});

test("maps 'do not honour' to card_declined", () => {
  const result = classify({
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Card declined by the issuing bank. Do not honour.",
    payment_method: "card",
  });

  assert.equal(result.root_cause, "card_declined");
});

test("maps a processing error to gateway_error", () => {
  const result = classify({
    error_code: "SERVER_ERROR",
    error_description: "Payment processing error at gateway.",
    payment_method: "upi",
  });

  assert.equal(result.root_cause, "gateway_error");
});

test("maps a dropped connection to network_drop", () => {
  const result = classify({
    error_code: "GATEWAY_ERROR",
    error_description: "Network connection error during authorization.",
    payment_method: "card",
  });

  assert.equal(result.root_cause, "network_drop");
});

test("maps an invalid CVV to invalid_credentials", () => {
  const result = classify({
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Invalid CVV entered.",
    payment_method: "card",
  });

  assert.equal(result.root_cause, "invalid_credentials");
});

// The important one: anything the rules do not recognise must NOT be handed
// to the agent. A fraud-flagged payment that got auto-nudged would be the
// worst possible failure mode for this project.
test("fails closed on an unrecognised failure reason", () => {
  const result = classify({
    error_code: "SERVER_ERROR",
    error_description: "Suspected fraud, transaction blocked for review.",
    payment_method: "card",
  });

  assert.equal(result.root_cause, "unknown");
  assert.equal(result.is_recoverable, false);
});

test("fails closed when the payload carries no failure reason at all", () => {
  const result = classify({});

  assert.equal(result.root_cause, "unknown");
  assert.equal(result.is_recoverable, false);
  assert.equal(result.payment_method, "unknown");
});

test("matches on error_code alone when no description is present", () => {
  const result = classify({
    error_code: "GATEWAY_ERROR",
    payment_method: "upi",
  });

  // "GATEWAY_ERROR" satisfies the gateway_error rule on its own.
  assert.equal(result.root_cause, "gateway_error");
  assert.equal(result.is_recoverable, true);
});

/**
 * Real Razorpay payloads, which the synthetic generator never produced.
 *
 * The classifier was written against our own generator's shape — error_code
 * plus a prose error_description — so every rule was tuned against sentences
 * we had written ourselves. A genuine failure arrives with a description of
 * "Payment failed", which carries nothing, and the actual signal two keys
 * away in fields nothing was reading.
 */
test("a real Razorpay failure is classified from its structured fields", () => {
  const result = classify({
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed",
    error_reason: "payment_failed",
    error_source: "gateway",
    error_step: "payment_authorization",
    payment_method: "card",
  });

  assert.notEqual(result.root_cause, "unknown", "this used to fall through to human review");
  assert.equal(result.root_cause, "gateway_error");
  assert.equal(result.is_recoverable, true);
});

test("the structured reason beats the prose description", () => {
  // The description would match nothing; the reason names the cause exactly.
  const result = classify({
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed",
    error_reason: "insufficient_funds",
    error_source: "issuer",
    payment_method: "card",
  });
  assert.equal(result.root_cause, "insufficient_funds");
});

test("error_source is a fallback, not a substitute for the reason", () => {
  // Only consulted when the reason is absent or unrecognised — it says
  // something broke, not what.
  const known = classify({ error_reason: "card_declined", error_source: "gateway" });
  assert.equal(known.root_cause, "card_declined", "reason wins over source");

  const unknownReason = classify({ error_reason: "something_new_from_razorpay", error_source: "bank" });
  assert.equal(unknownReason.root_cause, "bank_timeout", "source used when reason is unrecognised");
});

test("a fraud-flagged reason stays non-recoverable", () => {
  // The one automated action that could do real harm is chasing a payment
  // the issuer suspects is fraudulent.
  for (const reason of ["fraudulent_payment", "suspected_fraud"]) {
    const r = classify({ error_reason: reason, error_source: "issuer" });
    assert.equal(r.is_recoverable, false, `${reason} must not be retried`);
  }
});

test("an unrecognised reason AND source still fails closed", () => {
  const r = classify({
    error_code: "SOMETHING_NEW",
    error_description: "an error we have never seen",
    error_reason: "brand_new_reason",
    error_source: "brand_new_source",
  });
  assert.equal(r.root_cause, "unknown");
  assert.equal(r.is_recoverable, false);
});

test("the synthetic batch's prose payloads still classify as before", () => {
  // The new path must not regress the old one — the seeded batch carries no
  // structured fields at all.
  const r = classify({
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed due to insufficient funds in the account.",
    payment_method: "card",
  });
  assert.equal(r.root_cause, "insufficient_funds");
  assert.equal(r.is_recoverable, true);
});
