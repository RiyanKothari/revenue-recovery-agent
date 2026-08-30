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
