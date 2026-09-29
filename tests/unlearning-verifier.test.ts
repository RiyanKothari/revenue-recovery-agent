import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAGILITY_CAVEAT,
  MIN_PROBES_PER_COHORT,
  verifyUnlearning,
  type MembershipProbe,
} from "../lib/unlearning-verifier";

/**
 * The Unlearning Verifier.
 *
 * The assertions worth writing are about what it refuses to claim. Detecting
 * residual influence is the easy half; the hard half is never saying "the
 * data is gone", never accepting evidence the audited party chose, and never
 * dropping the caveat that this method is itself gameable.
 */

/**
 * A cohort whose confidences are drawn evenly across a band.
 *
 * Overlapping bands mean an attacker cannot separate the cohorts; separated
 * bands mean they can. Deterministic, so a verdict that moves means the input
 * moved.
 */
function cohort(
  which: "forget" | "control",
  count: number,
  low: number,
  high: number
): MembershipProbe[] {
  return Array.from({ length: count }, (_, i) => ({
    recordId: `${which}_${i}`,
    cohort: which,
    confidence: count === 1 ? low : low + ((high - low) * i) / (count - 1),
  }));
}

// --- the caveat is structural

test("every report carries the fragility caveat, whatever the verdict", () => {
  /**
   * Published work shows this method can be gamed by a provider who knows it
   * is coming. A verifier that hid that would be doing the thing it audits,
   * so the caveat is a required field rather than something a caller may
   * forget to print.
   */
  const cases = [
    [...cohort("forget", 5, 0.8, 0.9), ...cohort("control", 5, 0.1, 0.2)],
    [...cohort("forget", 200, 0.7, 1.0), ...cohort("control", 200, 0.0, 0.3)],
    [...cohort("forget", 400, 0.4, 0.6), ...cohort("control", 400, 0.4, 0.6)],
  ];

  for (const probes of cases) {
    const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });
    assert.equal(report.caveat, FRAGILITY_CAVEAT);
  }
});

// --- detecting influence

test("a model that still recognises forgotten records is caught", () => {
  // Cleanly separated confidences: the attacker wins outright.
  const probes = [...cohort("forget", 200, 0.7, 1.0), ...cohort("control", 200, 0.0, 0.3)];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });

  assert.equal(report.verdict, "residual_influence");
  assert.ok(report.attackerAdvantagePp > 90, `advantage was ${report.attackerAdvantagePp}`);
  assert.match(report.reason, /still behaves as though it holds/);
  assert.notEqual(report.thresholdUsed, null);
});

test("a model that has genuinely forgotten shows no advantage", () => {
  // Identical distributions: nothing separates the cohorts.
  const probes = [...cohort("forget", 2000, 0.2, 0.8), ...cohort("control", 2000, 0.2, 0.8)];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });

  assert.equal(report.verdict, "no_detectable_influence");
  assert.ok(report.minimumDetectableEffectPp !== null);
});

test("the strongest verdict available is still not 'the data is gone'", () => {
  /**
   * The line this tool must never cross. Absence of evidence is reported as
   * absence of evidence, with the sensitivity stated so a reader can judge
   * how much the null is worth.
   */
  const probes = [...cohort("forget", 2000, 0.2, 0.8), ...cohort("control", 2000, 0.2, 0.8)];
  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });

  assert.match(report.reason, /not evidence the data is gone/);
  assert.match(report.reason, /detectable down to about/);
  assert.doesNotMatch(report.reason, /deleted|erased|removed|proven/i);
});

// --- refusing to be fooled

test("a clean result on the audited party's own probes is capped", () => {
  /**
   * The same failure this whole product exists for: a platform validating
   * itself. A control set chosen by the party being audited can be chosen to
   * pass, so the measurement stands and the evidence does not.
   */
  const probes = [...cohort("forget", 2000, 0.2, 0.8), ...cohort("control", 2000, 0.2, 0.8)];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "platform" });

  assert.equal(report.verdict, "unverifiable_provenance");
  assert.match(report.reason, /party being audited/);
  assert.match(report.reason, /measurement is sound; the evidence it ran on is not independent/);
});

test("provenance does not soften a finding of residual influence", () => {
  /**
   * Asymmetric on purpose. If the platform's own probes still betray residual
   * influence, that is damning regardless of who chose them — nobody picks
   * evidence to incriminate themselves, so a self-selected set that fails is
   * stronger evidence, not weaker.
   */
  const probes = [...cohort("forget", 200, 0.7, 1.0), ...cohort("control", 200, 0.0, 0.3)];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "platform" });
  assert.equal(report.verdict, "residual_influence");
});

test("too few probes is a fact about the audit, not about the model", () => {
  const probes = [
    ...cohort("forget", MIN_PROBES_PER_COHORT - 1, 0.7, 1.0),
    ...cohort("control", 200, 0.0, 0.3),
  ];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });

  assert.equal(report.verdict, "insufficient");
  assert.match(report.reason, /fact about the audit, not about the model/);
});

test("a null result from a test too coarse to see anything is insufficient, not clean", () => {
  /**
   * The discipline every agent here shares. Forty probes a side cannot
   * resolve a five point advantage, so finding nothing says nothing.
   */
  const probes = [...cohort("forget", 40, 0.2, 0.8), ...cohort("control", 40, 0.2, 0.8)];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });

  assert.equal(report.verdict, "insufficient");
  assert.match(report.reason, /could be present and invisible/);
});

// --- the threshold sweep

test("the cutoff is chosen to favour the attacker, and that is the safe direction", () => {
  /**
   * The threshold is fitted on the same probes it is scored against, which
   * overstates the advantage. That is deliberate: erring toward "still
   * influenced" costs a platform some retraining, while erring the other way
   * tells a departed merchant their data is gone when it is not.
   *
   * Here only the top slice of the forget cohort is distinguishable. A fixed
   * midpoint cutoff would miss it; the sweep finds it.
   */
  const probes: MembershipProbe[] = [
    ...cohort("forget", 100, 0.40, 0.55),
    ...cohort("forget", 100, 0.90, 0.99),
    ...cohort("control", 200, 0.40, 0.55),
  ];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });

  assert.equal(report.verdict, "residual_influence");
  assert.ok(report.thresholdUsed! >= 0.55, "the sweep found the separating cutoff");
});

test("a partial leak is still a finding", () => {
  // Realistic unlearning rarely fails completely. A tenth of the cohort still
  // recognisable is residual influence.
  const probes: MembershipProbe[] = [
    ...cohort("forget", 700, 0.2, 0.6),
    ...cohort("forget", 100, 0.95, 1.0),
    ...cohort("control", 800, 0.2, 0.6),
  ];

  const report = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });
  assert.equal(report.verdict, "residual_influence");
});

test("materiality is adjustable and changes what counts as a leak", () => {
  const probes: MembershipProbe[] = [
    ...cohort("forget", 1960, 0.2, 0.6),
    ...cohort("forget", 40, 0.95, 1.0),
    ...cohort("control", 2000, 0.2, 0.6),
  ];

  // A 2pp advantage: real but below the default threshold.
  const lenient = verifyUnlearning({ merchantId: "m1", probes, provenance: "auditor" });
  assert.notEqual(lenient.verdict, "residual_influence");

  const strict = verifyUnlearning({
    merchantId: "m1",
    probes,
    provenance: "auditor",
    materialAdvantagePp: 1,
  });
  assert.equal(strict.verdict, "residual_influence");
});
