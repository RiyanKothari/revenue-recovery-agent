import { test } from "node:test";
import assert from "node:assert/strict";
import { assignArm } from "../lib/experiment";
import { DEFAULT_POLICY, type RecoveryPolicy } from "../lib/policy";

/**
 * The holdout is what turns attributed recovery into measured recovery, so
 * its two properties have to actually hold: assignment must be stable for a
 * given event, and the split must be roughly the configured size.
 */

function policyWith(overrides: Partial<RecoveryPolicy>): RecoveryPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

test("assignment is deterministic for the same event", () => {
  // A webhook retry must never flip an event between arms — that would
  // corrupt both denominators at once.
  const id = "evt_stable_1";
  const first = assignArm(id, DEFAULT_POLICY);

  for (let i = 0; i < 50; i++) {
    assert.equal(assignArm(id, DEFAULT_POLICY), first);
  }
});

test("splits approximately at the configured percentage", () => {
  const policy = policyWith({ holdoutPercent: 10 });
  const n = 20000;
  let control = 0;

  for (let i = 0; i < n; i++) {
    if (assignArm(`evt_${i}`, policy) === "control") control += 1;
  }

  const rate = (control / n) * 100;
  // Wide enough not to be flaky, tight enough to catch a broken hash.
  assert.ok(rate > 8 && rate < 12, `expected ~10% control, got ${rate.toFixed(2)}%`);
});

test("raising the holdout only adds to the control group", () => {
  // The salt is deliberately not derived from the policy version, so
  // increasing the holdout keeps the existing control group intact rather
  // than reshuffling everyone and invalidating the comparison.
  const small = policyWith({ holdoutPercent: 10 });
  const large = policyWith({ holdoutPercent: 20 });

  for (let i = 0; i < 2000; i++) {
    const id = `evt_${i}`;
    if (assignArm(id, small) === "control") {
      assert.equal(assignArm(id, large), "control");
    }
  }
});

test("a zero percent holdout treats everything", () => {
  const policy = policyWith({ holdoutPercent: 0 });
  for (let i = 0; i < 500; i++) {
    assert.equal(assignArm(`evt_${i}`, policy), "treated");
  }
});

test("a hundred percent holdout treats nothing", () => {
  const policy = policyWith({ holdoutPercent: 100 });
  for (let i = 0; i < 500; i++) {
    assert.equal(assignArm(`evt_${i}`, policy), "control");
  }
});
