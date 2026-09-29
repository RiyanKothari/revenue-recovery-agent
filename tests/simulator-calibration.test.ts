import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PERSONAS,
  simulate,
  simulateCohort,
  type Persona,
} from "../lib/customer-simulator";
import { certifyAgent, type SegmentEvidence } from "../lib/reality-check";
import { applyCalibration, buildCalibration } from "../lib/simulator-calibration";

/**
 * Closing the Reality Check loop: simulate, measure the gap, correct by it.
 *
 * The assertions that matter are the ones that stop this becoming astrology.
 * A correction derived from a comparison that could not resolve it is a
 * guess, and applying it would launder that guess into a number with a
 * decimal point on it — so the interesting tests are about refusing to
 * correct, not about correcting.
 */

function arm(n: number, converted: number) {
  return { n, converted, recoveredPaise: 0 };
}

// --- the simulator itself

test("the same cohort always predicts the same thing", () => {
  /**
   * A fidelity gap that moves must mean the agent moved. If the simulator
   * drifted run to run, every certification would be measuring noise.
   */
  const persona: Persona = { segment: "browsers", baseIntent: 0.5, walkAwayRate: 0.1, count: 500 };
  const a = simulateCohort(persona, { agentVersion: "v1" });
  const b = simulateCohort(persona, { agentVersion: "v1" });
  assert.deepEqual(a, b);
});

test("a different agent version is a different prediction", () => {
  const persona: Persona = { segment: "browsers", baseIntent: 0.5, walkAwayRate: 0.1, count: 500 };
  const v1 = simulateCohort(persona, { agentVersion: "v1" });
  const v2 = simulateCohort(persona, { agentVersion: "v2" });
  assert.notEqual(v1.converted, v2.converted);
});

test("segments do not contaminate each other", () => {
  // Hash-derived rather than a stateful PRNG, so simulating one segment
  // cannot change another's result depending on the order they ran.
  const a: Persona = { segment: "x", baseIntent: 0.5, walkAwayRate: 0.1, count: 300 };
  const b: Persona = { segment: "y", baseIntent: 0.5, walkAwayRate: 0.1, count: 300 };

  const forwards = simulate([a, b], { agentVersion: "v1" });
  const backwards = simulate([b, a], { agentVersion: "v1" });

  assert.equal(
    forwards.segments.find((s) => s.segment === "x")!.predicted.converted,
    backwards.segments.find((s) => s.segment === "x")!.predicted.converted
  );
});

test("ignoring walk-away is what inflates the prediction, and it says which mode ran", () => {
  /**
   * The published finding, made explicit. The bias is declared in the source
   * rather than discovered, so nobody mistakes finding it for evidence about
   * real simulators — but the harness must still be able to run both ways, or
   * the calibration layer would be measuring a constant baked into one file.
   */
  const persona: Persona = { segment: "reluctant", baseIntent: 0.6, walkAwayRate: 0.5, count: 2000 };

  const blind = simulateCohort(persona, { agentVersion: "v1" });
  const aware = simulateCohort(persona, { agentVersion: "v1", modelsWalkAway: true });

  assert.ok(blind.converted > aware.converted, "not seeing walk-away predicts more conversion");

  const run = simulate([persona], { agentVersion: "v1" });
  assert.equal(run.modelsWalkAway, false, "every run states which mode produced it");
});

test("the bias lands hardest where walk-away is highest", () => {
  // If every segment were wrong by the same amount, one global correction
  // would do and the per-segment machinery would be decoration.
  const gap = (p: Persona) => {
    const blind = simulateCohort(p, { agentVersion: "v1" });
    const aware = simulateCohort(p, { agentVersion: "v1", modelsWalkAway: true });
    return blind.converted / blind.n - aware.converted / aware.n;
  };

  const steady = gap({ segment: "loyal", baseIntent: 0.7, walkAwayRate: 0.02, count: 2000 });
  const flighty = gap({ segment: "reluctant", baseIntent: 0.6, walkAwayRate: 0.5, count: 2000 });

  assert.ok(flighty > steady * 3, `reluctant ${flighty.toFixed(3)} vs loyal ${steady.toFixed(3)}`);
});

// --- calibration

test("a measured gap becomes the correction", () => {
  const certification = certifyAgent({
    agent: "cart-agent@1",
    evidence: [evidence("reluctant", [400, 240], [400, 120])],
  });

  const calibration = buildCalibration(certification);
  const correction = calibration.corrections[0];

  assert.equal(correction.basis, "measured");
  assert.ok(correction.adjustmentPp > 25, "roughly the 30pp the simulator ran hot");
  assert.match(correction.reason, /ran .* hot/);
});

test("a segment too small to judge is never corrected", () => {
  /**
   * The rule that keeps this honest. Fitting a correction to a comparison
   * that could not resolve it is strictly worse than leaving it alone,
   * because the output then looks calibrated.
   */
  const certification = certifyAgent({
    agent: "cart-agent@1",
    evidence: [evidence("rare", [12, 10], [12, 2])],
  });

  const correction = buildCalibration(certification).corrections[0];

  assert.equal(correction.basis, "uncorrected");
  assert.equal(correction.adjustmentPp, 0);
  assert.match(correction.reason, /fitted to noise/);
});

test("no correction and unknown bias are different states", () => {
  // Zero with basis `measured` means we looked and found nothing. Zero with
  // basis `uncorrected` means we could not look.
  const agreed = buildCalibration(
    certifyAgent({ agent: "a", evidence: [evidence("browsers", [2000, 1000], [2000, 995])] })
  ).corrections[0];

  assert.equal(agreed.adjustmentPp, 0);
  assert.equal(agreed.basis, "measured");
  assert.match(agreed.reason, /No correction needed/);
});

test("a simulator with no usable evidence anywhere reports itself unusable", () => {
  const calibration = buildCalibration(
    certifyAgent({ agent: "a", evidence: [evidence("rare", [12, 10], [12, 2])] })
  );

  assert.equal(calibration.coverage.corrected, 0);
  assert.match(calibration.summary, /bias is still unknown/);
});

// --- applying it

test("a corrected prediction is usable and an uncorrected one is not", () => {
  const calibration = buildCalibration(
    certifyAgent({
      agent: "a",
      evidence: [evidence("reluctant", [400, 240], [400, 120]), evidence("rare", [12, 10], [12, 2])],
    })
  );

  const corrected = applyCalibration({ segment: "reluctant", rawRate: 0.6 }, calibration);
  assert.equal(corrected.usableForCertification, true);
  assert.ok(corrected.correctedRate < corrected.rawRate, "brought down by the measured gap");
  assert.ok(Math.abs(corrected.correctedRate - 0.3) < 0.02, "lands near the measured 30%");

  const untouched = applyCalibration({ segment: "rare", rawRate: 0.8 }, calibration);
  assert.equal(untouched.usableForCertification, false);
  assert.equal(untouched.correctedRate, untouched.rawRate, "passed through, not adjusted");
});

test("an unseen segment is passed through and flagged, not rejected", () => {
  // Populations change and new segments appear. That is not an error, but it
  // is emphatically not certifiable.
  const calibration = buildCalibration(
    certifyAgent({ agent: "a", evidence: [evidence("browsers", [2000, 1000], [2000, 995])] })
  );

  const unseen = applyCalibration({ segment: "brand_new", rawRate: 0.44 }, calibration);
  assert.equal(unseen.correctedRate, 0.44);
  assert.equal(unseen.usableForCertification, false);
  assert.match(unseen.note, /never been measured/);
});

test("a correction can never produce an impossible rate", () => {
  // A correction big enough to push a rate outside [0,1] is saying the
  // simulator and reality disagree about more than a percentage; returning a
  // negative conversion rate would carry that nonsense onward.
  const calibration = buildCalibration(
    certifyAgent({ agent: "a", evidence: [evidence("reluctant", [400, 400], [400, 0])] })
  );

  const clamped = applyCalibration({ segment: "reluctant", rawRate: 0.1 }, calibration);
  assert.ok(clamped.correctedRate >= 0 && clamped.correctedRate <= 1);
});

// --- the loop, end to end

test("simulate, measure, correct: the corrected prediction beats the raw one", () => {
  /**
   * The whole point in one test. The simulator runs blind to walk-away and
   * overpredicts. Reality Check measures the gap against what the holdout
   * recorded. The calibration corrects future predictions by it, and the
   * corrected number lands closer to reality than the raw one did.
   */
  const agentVersion = "cart-agent@1";
  const blind = simulate(DEFAULT_PERSONAS, { agentVersion });
  const truth = simulate(DEFAULT_PERSONAS, { agentVersion, modelsWalkAway: true });

  const evidenceSet: SegmentEvidence[] = DEFAULT_PERSONAS.map((persona) => ({
    segment: persona.segment,
    simulated: blind.segments.find((s) => s.segment === persona.segment)!.predicted,
    measured: truth.segments.find((s) => s.segment === persona.segment)!.predicted,
  }));

  const certification = certifyAgent({ agent: agentVersion, evidence: evidenceSet });
  assert.equal(certification.decision, "refused", "a blind simulator must not certify");

  const calibration = buildCalibration(certification);

  for (const persona of DEFAULT_PERSONAS) {
    const raw = blind.segments.find((s) => s.segment === persona.segment)!.predictedRate;
    const real = truth.segments.find((s) => s.segment === persona.segment)!.predictedRate;

    const corrected = applyCalibration({ segment: persona.segment, rawRate: raw }, calibration);
    if (!corrected.usableForCertification) continue;

    assert.ok(
      Math.abs(corrected.correctedRate - real) <= Math.abs(raw - real) + 1e-9,
      `${persona.segment}: corrected ${corrected.correctedRate.toFixed(3)} should be no further from ${real.toFixed(3)} than raw ${raw.toFixed(3)}`
    );
  }
});

function evidence(
  segment: string,
  sim: [number, number],
  real: [number, number]
): SegmentEvidence {
  return { segment, simulated: arm(sim[0], sim[1]), measured: arm(real[0], real[1]) };
}
