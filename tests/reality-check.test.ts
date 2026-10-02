import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATERIAL_FIDELITY_GAP_PP,
  assessSegment,
  certifyAgent,
  type SegmentEvidence,
} from "../lib/reality-check";

/**
 * Reality Check.
 *
 * The assertions that matter are the asymmetries. A simulator that flatters
 * an agent must refuse certification; one that is merely conservative must
 * not. And a segment nobody has enough data on must be able to block a
 * certificate without ever claiming the agent is bad — which is the
 * difference between a check and a rubber stamp.
 */

function arm(n: number, converted: number) {
  return { n, converted, recoveredPaise: 0 };
}

function evidence(
  segment: string,
  sim: [number, number],
  real: [number, number]
): SegmentEvidence {
  return {
    segment,
    simulated: arm(sim[0], sim[1]),
    measured: arm(real[0], real[1]),
  };
}

// --- one segment

test("a simulator that flatters the agent is called optimistic", () => {
  /**
   * The failure the paper describes. Simulated customers never walk away, so
   * an agent that pressures reluctant people looks excellent against them and
   * merely average against real customers who can leave.
   */
  const result = assessSegment(evidence("reluctant", [400, 240], [400, 120]));

  assert.equal(result.verdict, "optimistic");
  assert.ok(result.gapPp > 0);
  assert.match(result.reason, /easier population than it will meet/);
});

test("a simulator that understates conversion is forgiven, not failed", () => {
  /**
   * The asymmetry is the whole design. Overstating certifies an agent that
   * will underperform in the field. Understating wastes opportunity and
   * leaves no customer worse off, so it is reported and allowed.
   */
  const result = assessSegment(evidence("enthusiastic", [400, 120], [400, 240]));

  assert.equal(result.verdict, "pessimistic");
  assert.ok(result.gapPp < 0);
  assert.match(result.reason, /no customer is worse off/);
});

test("agreement only counts when the comparison could have seen a gap", () => {
  // Large arms, near-identical rates: the agreement is informative.
  const calibrated = assessSegment(evidence("browsers", [2000, 1000], [2000, 990]));
  assert.equal(calibrated.verdict, "calibrated");
  assert.ok(calibrated.minimumDetectableEffectPp! <= MATERIAL_FIDELITY_GAP_PP);
  assert.match(calibrated.reason, /informative rather than merely unmeasured/);

  // Same near-identical rates, arms far too small to resolve five points.
  const unmeasured = assessSegment(evidence("browsers", [60, 30], [60, 29]));
  assert.equal(unmeasured.verdict, "insufficient");
  assert.match(unmeasured.reason, /could be present and invisible/);
});

test("a tiny segment can neither certify nor refuse", () => {
  const result = assessSegment(evidence("rare", [12, 10], [12, 2]));

  assert.equal(result.verdict, "insufficient");
  assert.match(result.reason, /neither certify nor refuse/);
});

test("a real but immaterial gap is not a finding", () => {
  // At large n a fraction of a point becomes detectable and still means
  // nothing. Same discipline as the Fairness Auditor.
  const result = assessSegment(evidence("bulk", [20000, 10000], [20000, 9700]));
  assert.equal(result.verdict, "calibrated");
});

test("the materiality threshold is adjustable", () => {
  const strict = assessSegment(evidence("bulk", [20000, 10000], [20000, 9700]), 1);
  assert.equal(strict.verdict, "optimistic");
});

// --- the certificate

test("one optimistic segment refuses the whole certificate", () => {
  /**
   * Never an average. Averaging is exactly how this bias survives a review:
   * the well-modelled segments are also the larger ones, so a mean fidelity
   * gap is dominated by the customers the simulator already gets right.
   */
  const result = certifyAgent({
    agent: "cart-agent@1",
    evidence: [
      evidence("browsers", [2000, 1000], [2000, 995]),
      evidence("loyal", [2000, 1400], [2000, 1390]),
      evidence("reluctant", [400, 240], [400, 120]),
    ],
  });

  assert.equal(result.decision, "refused");
  // The summary has to name the worst segment, or nobody knows where to look.
  assert.match(result.summary, /reluctant/);
  assert.match(result.summary, /1 of 3 segments/);
});

test("a segment nobody has data on blocks the certificate without accusing the agent", () => {
  const result = certifyAgent({
    agent: "cart-agent@1",
    evidence: [
      evidence("browsers", [2000, 1000], [2000, 995]),
      evidence("rare", [12, 10], [12, 9]),
    ],
  });

  assert.equal(result.decision, "insufficient_evidence");
  assert.match(result.summary, /not evidence of fidelity/);
});

test("a certificate is granted only when every segment tracks reality", () => {
  const result = certifyAgent({
    agent: "cart-agent@1",
    evidence: [
      evidence("browsers", [2000, 1000], [2000, 995]),
      evidence("loyal", [2000, 1400], [2000, 1390]),
    ],
  });

  assert.equal(result.decision, "certified");
  assert.match(result.summary, /large enough for that agreement to mean something/);
});

test("conservative segments still certify, and the summary says so", () => {
  const result = certifyAgent({
    agent: "cart-agent@1",
    evidence: [
      evidence("browsers", [2000, 1000], [2000, 995]),
      evidence("enthusiastic", [400, 120], [400, 240]),
    ],
  });

  assert.equal(result.decision, "certified");
  assert.match(result.summary, /conservatively, which is the safe direction/);
});

test("nothing submitted is not a pass", () => {
  const result = certifyAgent({ agent: "cart-agent@1", evidence: [] });
  assert.equal(result.decision, "insufficient_evidence");
});

test("optimism outranks insufficiency, because a known flaw beats an unknown one", () => {
  // If both are present the refusal has to win: there is a demonstrated
  // problem, and reporting "insufficient evidence" would understate it.
  const result = certifyAgent({
    agent: "cart-agent@1",
    evidence: [evidence("rare", [12, 10], [12, 2]), evidence("reluctant", [400, 240], [400, 120])],
  });

  assert.equal(result.decision, "refused");
});

test("an inconclusive segment names its sensitivity in words a rate can take", () => {
  /**
   * Forty a side clears the evidence floor but cannot resolve a five point
   * gap, so the verdict is insufficient and the reason has to say how coarse
   * the comparison was. That phrase now comes from describeSensitivity rather
   * than a hand-built `.toFixed(1)}pp` that printed "?pp" for a missing value.
   */
  const result = assessSegment(evidence("small", [40, 20], [40, 20]));

  assert.equal(result.verdict, "insufficient");
  assert.doesNotMatch(result.reason, /\?pp|NaN|undefined/);
  assert.match(result.reason, /could only have resolved about \d+\.\dpp/);
});
