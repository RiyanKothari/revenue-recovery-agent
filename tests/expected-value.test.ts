import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpectedValue } from "../lib/expected-value";
import { estimateRecoveryProbability, tallyByRootCause } from "../lib/propensity";
import { DEFAULT_POLICY, type RecoveryPolicy } from "../lib/policy";

function policyWith(overrides: Partial<RecoveryPolicy>): RecoveryPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

/**
 * The economic gate exists to stop the agent destroying value while
 * reporting recovery — spending ₹50 of human time to chase ₹40. It runs
 * before the model, so these are hard bounds, not suggestions.
 */

test("proceeds on a large payment with a decent recovery chance", () => {
  const result = evaluateExpectedValue({
    amountPaise: 500000, // ₹5,000
    probability: 0.4,
    policy: DEFAULT_POLICY,
  });

  assert.equal(result.proceed, true);
  assert.equal(result.expectedRecoveryPaise, 200000);
});

test("refuses when the expected recovery is smaller than the cost of trying", () => {
  // ₹0.50 payment at 1% — expected recovery is well under the cheapest send.
  const result = evaluateExpectedValue({
    amountPaise: 50,
    probability: 0.01,
    policy: DEFAULT_POLICY,
  });

  assert.equal(result.proceed, false);
  assert.match(result.reason!, /negative_expected_value/);
});

test("evaluates against the cheapest channel, not the most expensive", () => {
  // The model has not chosen a channel yet. Gating on the dearest option
  // would refuse payments that are clearly worth an email.
  const policy = policyWith({
    channelCostPaise: { email: 5, whatsapp: 70, human_escalation: 5000 },
  });

  const result = evaluateExpectedValue({
    amountPaise: 20000, // ₹200
    probability: 0.05, // expected ₹10
    policy,
  });

  assert.equal(result.actionCostPaise, 5);
  assert.equal(result.proceed, true);
});

test("a zero recovery probability never proceeds", () => {
  const result = evaluateExpectedValue({
    amountPaise: 10000000,
    probability: 0,
    policy: DEFAULT_POLICY,
  });

  assert.equal(result.proceed, false);
});

test("margin rate reduces the value of a recovery", () => {
  // Modelling contribution margin rather than gross: only part of a
  // recovered payment is actually worth something.
  const full = evaluateExpectedValue({
    amountPaise: 100000,
    probability: 0.3,
    policy: policyWith({ marginRate: 1 }),
  });
  const partial = evaluateExpectedValue({
    amountPaise: 100000,
    probability: 0.3,
    policy: policyWith({ marginRate: 0.1 }),
  });

  assert.ok(partial.expectedValuePaise < full.expectedValuePaise);
});

test("raising the minimum threshold makes the gate stricter", () => {
  const input = { amountPaise: 1000, probability: 0.1 }; // expected ₹1

  assert.equal(
    evaluateExpectedValue({ ...input, policy: policyWith({ minExpectedValuePaise: 0 }) })
      .proceed,
    true
  );
  assert.equal(
    evaluateExpectedValue({
      ...input,
      policy: policyWith({ minExpectedValuePaise: 50000 }),
    }).proceed,
    false
  );
});

// --- Propensity

test("falls back to the root cause prior with no observations", () => {
  // Transient infrastructure failures had a valid payment method, so they
  // start optimistic; declines need the customer to fix something.
  const timeout = estimateRecoveryProbability("bank_timeout");
  const declined = estimateRecoveryProbability("card_declined");

  assert.ok(timeout > declined);
  assert.ok(timeout > 0 && timeout < 1);
});

test("observed outcomes move the estimate away from the prior", () => {
  const prior = estimateRecoveryProbability("card_declined");
  const observed = estimateRecoveryProbability("card_declined", {
    trials: 200,
    successes: 160,
  });

  assert.ok(observed > prior + 0.3, "200 observations should dominate a light prior");
});

test("the prior stops mattering as evidence accumulates", () => {
  const few = estimateRecoveryProbability("unknown", { trials: 5, successes: 5 });
  const many = estimateRecoveryProbability("unknown", { trials: 2000, successes: 2000 });

  assert.ok(many > few);
  assert.ok(many > 0.95);
});

test("clamps malformed observations instead of producing an invalid probability", () => {
  // More successes than trials would otherwise yield p > 1 and silently
  // corrupt every expected-value calculation downstream.
  const p = estimateRecoveryProbability("bank_timeout", { trials: 5, successes: 99 });

  assert.ok(p >= 0 && p <= 1, `probability out of range: ${p}`);
});

test("an unrecognised root cause still gets a usable prior", () => {
  const p = estimateRecoveryProbability("something_new_razorpay_added");
  assert.ok(p > 0 && p < 1);
});

test("tallies outcomes by root cause", () => {
  const tally = tallyByRootCause([
    { root_cause: "bank_timeout", recovered: true },
    { root_cause: "bank_timeout", recovered: false },
    { root_cause: "bank_timeout", recovered: true },
    { root_cause: "card_declined", recovered: false },
    { root_cause: null, recovered: true },
  ]);

  assert.deepEqual(tally.bank_timeout, { trials: 3, successes: 2 });
  assert.deepEqual(tally.card_declined, { trials: 1, successes: 0 });
  assert.deepEqual(tally.unknown, { trials: 1, successes: 1 });
});
