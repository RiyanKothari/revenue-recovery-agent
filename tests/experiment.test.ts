import { test } from "node:test";
import assert from "node:assert/strict";
import { assignArm, assessPower, computeLift, type ArmOutcome } from "../lib/experiment";
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

// --- Lift maths

function arm(n: number, converted: number, recoveredPaise: number): ArmOutcome {
  return { n, converted, recoveredPaise };
}

test("computes absolute lift between the arms", () => {
  // 34% treated vs 19% control = +15pp
  const lift = computeLift(arm(500, 170, 17000000), arm(100, 19, 1900000));

  assert.ok(Math.abs(lift.treatedRate - 0.34) < 1e-9);
  assert.ok(Math.abs(lift.controlRate - 0.19) < 1e-9);
  assert.ok(Math.abs(lift.absoluteLiftPp - 15) < 1e-6);
});

test("incremental recovery subtracts the do-nothing baseline", () => {
  // Control recovered ₹19,000 across 100 events = ₹190/event baseline.
  // Treated 500 events would have brought in ₹95,000 on their own;
  // they brought in ₹170,000, so ₹75,000 is incremental.
  const lift = computeLift(arm(500, 170, 17000000), arm(100, 19, 1900000));

  assert.equal(lift.incrementalPaise, 17000000 - 1900000 / 100 * 500);
  assert.equal(lift.incrementalPaise, 7500000);
});

test("incremental recovery is less than gross recovery", () => {
  // The entire point: the agent cannot claim customers who would have paid
  // anyway.
  const lift = computeLift(arm(400, 120, 12000000), arm(100, 20, 2000000));

  assert.ok(lift.incrementalPaise! < 12000000);
});

test("reports a confidence interval and flags significance", () => {
  const lift = computeLift(arm(2000, 680, 68000000), arm(2000, 380, 38000000));

  assert.ok(lift.ci95Pp, "expected an interval");
  const [low, high] = lift.ci95Pp!;
  assert.ok(low < lift.absoluteLiftPp && lift.absoluteLiftPp < high);
  assert.ok(low > 0, "a 15pp lift on n=2000 per arm should exclude zero");
  assert.equal(lift.significant, true);
});

test("a lift that could be noise is not called significant", () => {
  // 2pp apart on small arms — the interval must straddle zero.
  const lift = computeLift(arm(60, 20, 2000000), arm(60, 19, 1900000));

  assert.equal(lift.significant, false);
  assert.ok(lift.ci95Pp![0] < 0 && lift.ci95Pp![1] > 0);
});

test("warns when the arms are too small to conclude anything", () => {
  // The original 55-event batch with a 10% holdout gives ~5 control events.
  const lift = computeLift(arm(50, 17, 1700000), arm(5, 1, 100000));

  assert.ok(lift.caveat, "small arms must be flagged, not silently reported");
  assert.match(lift.caveat!, /directional/);
});

test("returns a caveat rather than dividing by zero with no control arm", () => {
  const lift = computeLift(arm(100, 34, 3400000), arm(0, 0, 0));

  assert.equal(lift.incrementalPaise, null);
  assert.equal(lift.significant, false);
  assert.match(lift.caveat!, /cannot be measured/);
});

test("handles a negative lift without breaking", () => {
  // If intervening actively hurt, the number must say so.
  const lift = computeLift(arm(500, 100, 10000000), arm(500, 150, 15000000));

  assert.ok(lift.absoluteLiftPp < 0);
  assert.ok(lift.incrementalPaise! < 0);
});

/**
 * "Not significant" is ambiguous in the worst way — it reads as "the agent
 * did not work" when it usually means "this holdout was never big enough to
 * tell". These assertions pin the difference.
 */
test("a small holdout reports a large minimum detectable effect", () => {
  const power = assessPower(
    { n: 270, converted: 92, recoveredPaise: 0 },
    { n: 30, converted: 5, recoveredPaise: 0 }
  );

  assert.ok(power.minimumDetectableEffectPp !== null);
  // Thirty control observations cannot resolve a fifteen point difference.
  assert.ok(
    power.minimumDetectableEffectPp! > 15,
    `expected a large MDE, got ${power.minimumDetectableEffectPp}`
  );
  assert.equal(power.adequatelyPowered, false);
});

test("a large holdout resolves the same effect", () => {
  const power = assessPower(
    { n: 1400, converted: 476, recoveredPaise: 0 },
    { n: 600, converted: 114, recoveredPaise: 0 }
  );

  assert.ok(power.minimumDetectableEffectPp! < 15);
  assert.equal(power.adequatelyPowered, true);
});

test("it says how many control observations the observed effect would need", () => {
  const power = assessPower(
    { n: 270, converted: 92, recoveredPaise: 0 },
    { n: 30, converted: 5, recoveredPaise: 0 }
  );

  assert.ok(power.controlNeededForObserved !== null);
  assert.ok(
    power.controlNeededForObserved! > 30,
    "an underpowered arm must ask for more than it has"
  );
});

test("an empty arm reports no power rather than a misleading zero", () => {
  // Zero would read as "any effect is detectable", the exact opposite of true.
  const power = assessPower(
    { n: 0, converted: 0, recoveredPaise: 0 },
    { n: 0, converted: 0, recoveredPaise: 0 }
  );

  assert.equal(power.minimumDetectableEffectPp, null);
  assert.equal(power.adequatelyPowered, false);
});

test("a control arm that never converts does not divide by zero", () => {
  const power = assessPower(
    { n: 100, converted: 30, recoveredPaise: 0 },
    { n: 40, converted: 0, recoveredPaise: 0 }
  );
  assert.equal(power.minimumDetectableEffectPp, null);
});
