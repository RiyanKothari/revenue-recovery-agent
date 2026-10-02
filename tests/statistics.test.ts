import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessPower,
  computeLift,
  describeSensitivity,
  fisherExactTwoSided,
  type ArmOutcome,
} from "../lib/statistics";

/**
 * The arithmetic behind every measured claim this system makes, tested
 * against `lib/statistics.ts` directly.
 *
 * These assertions used to live in `experiment.test.ts` and reach the module
 * through `experiment.ts`'s re-export, which is how `lib/statistics.ts` came
 * to look untested to anything that matches test files to source files — and
 * to anyone reading the directory. It was in fact the most heavily tested
 * module here. The re-export is a compatibility shim, not the seam these
 * tests are about: `computeLift` and `assessPower` decide whether the
 * dashboard calls a result significant, whether the fairness audit reports a
 * disparity, and whether the unlearning verifier reports residual influence,
 * none of which is an experiment-assignment concern.
 *
 * `experiment.test.ts` keeps the holdout-assignment tests, and
 * `pattern-engine.test.ts` separately pins that the re-exports are still the
 * same function objects, so nothing is lost by importing from the real home
 * here.
 */

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

/**
 * A control arm that converted nobody is the normal early state of a small
 * holdout, not an edge case. Evaluating the power variance at the control
 * rate alone made it zero there, and the module answered "no power
 * calculation available" — which switches off the dashboard's explanation of
 * why nothing was significant at the one moment a reader most needs it, and
 * leaves the fairness audit printing a literal "?pp" into its reasoning.
 * Pooling across both arms gives a real answer.
 */
test("a control arm that never converts still gets a power calculation", () => {
  const power = assessPower(
    { n: 100, converted: 30, recoveredPaise: 0 },
    { n: 40, converted: 0, recoveredPaise: 0 }
  );

  assert.ok(
    power.minimumDetectableEffectPp !== null,
    "a zero-conversion control arm is the case the MDE exists to explain"
  );
  assert.ok(power.minimumDetectableEffectPp! > 0);
  // 140 events pooled at a 21% rate cannot resolve a hair's breadth, and it
  // must not claim to.
  assert.ok(
    power.minimumDetectableEffectPp! > 10,
    `expected a coarse MDE on 40 control events, got ${power.minimumDetectableEffectPp}`
  );
});

/**
 * Four call sites report a null result by naming the sensitivity it was
 * measured at. On small arms the MDE comes out above 100pp — a difference of
 * two rates larger than the whole range they can differ by — and a reader who
 * sees "could have resolved about 198.1pp" on the panel whose job is to be the
 * trustworthy one stops trusting the panel.
 */
test("sensitivity is described in terms a rate difference can actually take", () => {
  assert.equal(describeSensitivity(12.34), "about 12.3pp");
  assert.equal(describeSensitivity(100), "about 100.0pp");
  assert.match(describeSensitivity(198.1), /no difference that could exist/);
  assert.match(describeSensitivity(null), /cannot establish/);
  // Never the literal "?pp" one of those sites used to interpolate.
  for (const v of [null, 0.4, 99.9, 114.4, 1e6]) {
    assert.doesNotMatch(describeSensitivity(v), /\?/);
    assert.doesNotMatch(describeSensitivity(v), /NaN|undefined|null/);
  }
});

test("the power result says when it can resolve nothing at all", () => {
  // Three against three cannot resolve any difference that could exist.
  const tiny = assessPower(
    { n: 3, converted: 3, recoveredPaise: 0 },
    { n: 3, converted: 0, recoveredPaise: 0 }
  );
  assert.ok(tiny.minimumDetectableEffectPp! > 100);
  assert.equal(tiny.resolvesAnyPossibleEffect, false);

  const ample = assessPower(
    { n: 1400, converted: 476, recoveredPaise: 0 },
    { n: 600, converted: 114, recoveredPaise: 0 }
  );
  assert.ok(ample.minimumDetectableEffectPp! < 100);
  assert.equal(ample.resolvesAnyPossibleEffect, true);
});

test("no conversions anywhere reports no power rather than a false zero", () => {
  // Pooling cannot rescue this one: nothing converted in either arm, so there
  // is no variation to estimate a detectable difference from. Reporting 0pp
  // would read as "any effect is detectable", the exact opposite of true.
  const power = assessPower(
    { n: 50, converted: 0, recoveredPaise: 0 },
    { n: 50, converted: 0, recoveredPaise: 0 }
  );

  assert.equal(power.minimumDetectableEffectPp, null);
  assert.equal(power.adequatelyPowered, false);
});

/**
 * The bug this pins cost nothing to produce and would have been expensive to
 * believe. Wald's standard error is built from the observed rates, so an arm
 * at 0% or 100% contributes zero variance — it looks perfectly certain
 * because it never varied. One treated event against one control event gave a
 * 95% interval of exactly [+100pp, +100pp] and `significant: true`.
 *
 * Every caller reads that flag as a finding: the fairness audit reports a
 * disparity against a protected segment, the unlearning verifier reports
 * residual influence from supposedly-forgotten data, the reality check calls
 * the simulator miscalibrated. Two observations cannot support any of that.
 */
test("a single event per arm is never called significant", () => {
  const lift = computeLift(arm(1, 1, 100000), arm(1, 0, 0));

  assert.equal(
    lift.significant,
    false,
    "one event against one event cannot establish anything"
  );
  const [low, high] = lift.ci95Pp!;
  assert.ok(high - low > 50, `expected a very wide interval, got [${low}, ${high}]`);
  assert.ok(low < 0 && high > 0, "the interval must admit that there may be no effect");
});

test("an interval on a boundary rate never has zero width", () => {
  // Every one of these has at least one arm at 0% or 100%, which is where the
  // unadjusted interval collapsed to a single point and read as certainty.
  const boundary: Array<[string, ArmOutcome, ArmOutcome]> = [
    ["3/3 vs 0/3", arm(3, 3, 300000), arm(3, 0, 0)],
    ["2/2 vs 0/5", arm(2, 2, 200000), arm(5, 0, 0)],
    ["0/4 vs 0/4", arm(4, 0, 0), arm(4, 0, 0)],
    ["8/8 vs 8/8", arm(8, 8, 800000), arm(8, 8, 800000)],
    ["40/40 vs 0/40", arm(40, 40, 4000000), arm(40, 0, 0)],
  ];

  for (const [label, treated, control] of boundary) {
    const lift = computeLift(treated, control);
    if (lift.ci95Pp === null) continue; // withheld — asserted on separately below
    const [low, high] = lift.ci95Pp;
    assert.ok(high > low, `${label}: a 95% interval of zero width is not a 95% interval`);
  }
});

/**
 * No arm configuration may leave a reader with an interval that excludes zero
 * next to a verdict of "not significant". The interval is approximate and the
 * verdict is exact, so where they disagree the interval is withheld — a
 * contradiction gets resolved by whichever half flatters the result, and the
 * dashboard draws the interval against a zero line specifically to make
 * excluding zero legible at a glance.
 */
test("an interval is never shown excluding zero while the verdict says otherwise", () => {
  for (let tn = 1; tn <= 24; tn++) {
    for (let cn = 1; cn <= 24; cn++) {
      for (let tc = 0; tc <= tn; tc++) {
        for (let cc = 0; cc <= cn; cc++) {
          const lift = computeLift(arm(tn, tc, tc * 100000), arm(cn, cc, cc * 100000));
          if (lift.significant || lift.ci95Pp === null) continue;
          const [low, high] = lift.ci95Pp;
          assert.ok(
            low <= 0 && high >= 0,
            `${tc}/${tn} vs ${cc}/${cn}: not significant (p=${lift.pValue?.toFixed(3)}) ` +
              `yet the interval [${low.toFixed(1)}, ${high.toFixed(1)}] excludes zero`
          );
        }
      }
    }
  }
});

test("withholding the interval says why, and still reports the exact p-value", () => {
  // 3/3 against 0/3 looks total and is not: the chance of a split this
  // lopsided arising on its own is one in ten.
  const lift = computeLift(arm(3, 3, 300000), arm(3, 0, 0));

  assert.equal(lift.significant, false);
  assert.equal(lift.ci95Pp, null);
  assert.ok(Math.abs(lift.pValue! - 0.1) < 1e-9, `expected p=0.1, got ${lift.pValue}`);
  assert.match(lift.caveat!, /exact test/);
  // The point estimate is still reported — nothing measured is withheld, only
  // a claim about precision.
  assert.ok(Math.abs(lift.absoluteLiftPp - 100) < 1e-9);
});

test("the interval never leaves the range a difference of rates can occupy", () => {
  // The normal approximation does not know proportions are bounded and will
  // print +108pp given the chance.
  const [low, high] = computeLift(arm(400, 400, 40000000), arm(400, 0, 0)).ci95Pp!;

  assert.ok(low >= -100 && low <= 100, `low out of range: ${low}`);
  assert.ok(high >= -100 && high <= 100, `high out of range: ${high}`);
  assert.equal(high, 100, "a near-total separation should press against the ceiling");
  assert.equal(low > 0, true, "and still be significant on four hundred per arm");
});

/**
 * The case that was actually reachable, and the reason this matters beyond
 * arithmetic.
 *
 * The fairness audit, the reality check and the unlearning verifier each
 * refuse to read `significant` below thirty per arm, so the degenerate
 * interval never reached their findings. The dashboard's headline chip has no
 * such floor, and the batch shape this repo documents for a demo — around
 * fifty events at a 10% holdout — lands squarely in the gap: five control
 * events that happened to recover nobody gave a 95% interval of
 * [+20.9pp, +47.1pp] and a green chip, where the exact probability of a split
 * that lopsided arising by chance is 0.31.
 *
 * A demo is exactly where an overstated number does the most damage, because
 * it is the number someone repeats.
 */
test("a demo-sized batch does not manufacture a significant lift", () => {
  const lift = computeLift(arm(50, 17, 1700000), arm(5, 0, 0));

  assert.equal(lift.significant, false, "p=0.31 is not a finding");
  assert.ok(lift.pValue! > 0.3);
  // The point estimate and the interval are still reported — a +34pp
  // difference on this batch is real, it is just not yet distinguishable from
  // chance, and the interval has to show that by including zero.
  assert.ok(Math.abs(lift.absoluteLiftPp - 34) < 1e-9);
  assert.ok(lift.ci95Pp![0] < 0, "an interval that cannot exclude zero must show zero");
  assert.match(lift.caveat!, /directional/);
});

test("a tiny holdout with no control recoveries is not a finding", () => {
  // 18 treated against 2 control: the old interval was [+11.6pp, +55.1pp].
  const lift = computeLift(arm(18, 6, 600000), arm(2, 0, 0));

  assert.equal(lift.significant, false);
  assert.equal(lift.pValue, 1);
});

/**
 * The exact test is the thing every significance verdict now rests on, so it
 * is pinned against hand-computable values rather than only through its
 * callers. All four are closed forms over C(6,3)=20 or C(2,1)=2, so a drift in
 * the log-gamma approximation shows up here rather than as a quietly wrong
 * fairness finding.
 */
test("Fisher's exact test matches values computable by hand", () => {
  // 3/3 vs 0/3: the two extreme tables, 1/20 each, two-sided 0.1.
  assert.ok(
    Math.abs(fisherExactTwoSided(arm(3, 3, 0), arm(3, 0, 0)) - 0.1) < 1e-9,
    `got ${fisherExactTwoSided(arm(3, 3, 0), arm(3, 0, 0))}`
  );

  // 1/1 vs 0/1: both possible tables are equally likely, so nothing is
  // surprising and the p-value is 1.
  assert.ok(Math.abs(fisherExactTwoSided(arm(1, 1, 0), arm(1, 0, 0)) - 1) < 1e-9);

  // No conversions anywhere: one possible table.
  assert.equal(fisherExactTwoSided(arm(9, 0, 0), arm(9, 0, 0)), 1);

  // Everyone converted: likewise one possible table, not a perfect tie worth
  // reporting.
  assert.equal(fisherExactTwoSided(arm(9, 9, 0), arm(9, 9, 0)), 1);
});

test("the exact test is symmetric and stays a probability at scale", () => {
  // Swapping the arms flips the sign of the effect, not the evidence for it.
  const a = fisherExactTwoSided(arm(2000, 680, 0), arm(2000, 380, 0));
  const b = fisherExactTwoSided(arm(2000, 380, 0), arm(2000, 680, 0));
  assert.ok(Math.abs(a - b) < 1e-12, `asymmetric: ${a} vs ${b}`);

  // Log-gamma on factorials of 20,000 must not overflow, go negative, or
  // exceed one.
  const big = fisherExactTwoSided(arm(10000, 3400, 0), arm(10000, 3380, 0));
  assert.ok(Number.isFinite(big) && big >= 0 && big <= 1, `out of range: ${big}`);
  assert.ok(big > 0.05, "a 0.2pp difference on 10k arms is not a finding");
});

test("a real separation on adequate arms is still called significant", () => {
  // The guard against false positives must not have cost the true ones: the
  // adjustment adds one notional observation per arm, which is negligible at
  // this size.
  const lift = computeLift(arm(300, 120, 12000000), arm(300, 60, 6000000));

  assert.equal(lift.significant, true);
  assert.ok(lift.ci95Pp![0] > 0);
});
