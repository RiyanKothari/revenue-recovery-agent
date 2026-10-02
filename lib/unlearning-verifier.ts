import {
  assessPower,
  computeLift,
  describeSensitivity,
  type ArmOutcome,
} from "./statistics";

/**
 * The Unlearning Verifier — did the model actually forget?
 *
 * ## The question nobody answers
 *
 * A merchant leaves a payments platform. The platform deletes their rows and
 * says so. But a shared risk or routing model was trained on those rows, and
 * deleting a database record does not remove what a model learned from it.
 * MediaNama asked this directly about Vulcan — what happens to what the model
 * already learned if a merchant opts out — and got no answer.
 *
 * "We deleted your data" and "our model no longer behaves as though it has
 * your data" are different claims, and only the second one is what the
 * merchant actually wanted.
 *
 * ## How you test it
 *
 * Membership inference. If the model still behaves measurably differently on
 * records it was trained on than on comparable records it never saw, the
 * training data is still in there. Give an attacker the model's confidence on
 * each record and ask them to guess membership: an attacker who does better
 * than chance has found residual influence.
 *
 * The pleasing part is that this is **the same two-proportion test** as
 * everything else in this codebase. The attacker's advantage is the true
 * positive rate minus the false positive rate, which is exactly the shape
 * `computeLift` already handles — and `assessPower` then answers the question
 * that makes a null result meaningful: could this test have detected residual
 * influence if there were any?
 *
 * ## Three things this refuses to do
 *
 * 1. **It never says the data is gone.** The strongest honest verdict is "no
 *    residual influence detectable at this sensitivity", with the sensitivity
 *    stated. Absence of evidence is reported as absence of evidence.
 * 2. **It never lets the audited party choose the evidence.** A platform that
 *    supplies its own control set can supply a flattering one, which is the
 *    same failure as an agent platform validating its own agents. Probe
 *    provenance is recorded and a platform-chosen set caps the verdict.
 * 3. **It never omits the fragility caveat.** Published work shows unlearning
 *    verification can itself be gamed by a party that knows it is being
 *    tested. That is not a footnote, so it is a required field on the report
 *    rather than something a caller may forget to print.
 */

/**
 * The caveat that ships with every report, because the method has a known
 * weakness and a verifier that hid it would be doing the thing it audits.
 *
 * Grounded in arXiv 2408.00929, "Verification of Machine Unlearning is
 * Fragile": a provider aware it will be tested this way can produce a model
 * that passes while retaining influence. This tool therefore raises the cost
 * of a false claim; it does not make one impossible.
 */
export const FRAGILITY_CAVEAT =
  "Unlearning verification is known to be fragile: a provider who knows this test is coming can produce a model that passes it while retaining influence. A pass raises the cost of a false claim rather than making one impossible, and should be read as evidence, not proof.";

export interface MembershipProbe {
  recordId: string;
  /**
   * `forget` — records the merchant asked to have unlearned.
   * `control` — comparable records the model was never trained on.
   */
  cohort: "forget" | "control";
  /**
   * The model's confidence on this record, 0 to 1.
   *
   * What produces it is deliberately left to the caller: loss, max softmax,
   * a calibrated probability. The test only needs a score that is higher when
   * the model finds a record familiar, and fixing the definition here would
   * tie the verifier to one model architecture.
   */
  confidence: number;
}

/**
 * Who selected the probes.
 *
 * The audited party choosing its own control set is the same failure mode as
 * a platform validating its own agents, which is the gap this whole product
 * exists for. Recorded rather than assumed.
 */
export type ProbeProvenance = "auditor" | "platform";

export type UnlearningVerdict =
  | "residual_influence"
  | "no_detectable_influence"
  | "insufficient"
  | "unverifiable_provenance";

export interface UnlearningReport {
  merchantId: string;
  forget: { n: number; flaggedAsMember: number };
  control: { n: number; flaggedAsMember: number };
  /** True positive rate minus false positive rate, in percentage points. */
  attackerAdvantagePp: number;
  /** The confidence cutoff that maximised the attacker's advantage. */
  thresholdUsed: number | null;
  ci95Pp: [number, number] | null;
  minimumDetectableEffectPp: number | null;
  verdict: UnlearningVerdict;
  provenance: ProbeProvenance;
  reason: string;
  /** Always present. See FRAGILITY_CAVEAT. */
  caveat: string;
}

/** An advantage smaller than this is not treated as residual influence. */
export const MATERIAL_ADVANTAGE_PP = 5;

/** Below this many probes per cohort the interval means nothing. */
export const MIN_PROBES_PER_COHORT = 30;

function arm(probes: MembershipProbe[], threshold: number): ArmOutcome {
  return {
    n: probes.length,
    // "The attacker called this a member." Confidence at or above the cutoff
    // means the model found the record familiar.
    converted: probes.filter((p) => p.confidence >= threshold).length,
    recoveredPaise: 0,
  };
}

/**
 * Verifies that a merchant's data no longer influences the model.
 *
 * The threshold is swept rather than fixed, and the best one for the attacker
 * is chosen. That deliberately **overstates** the attacker's advantage, since
 * the cutoff is fitted on the same probes it is scored against — and
 * overstating is the safe direction here. This is a safety check, so erring
 * toward "still influenced" costs a platform some unnecessary retraining,
 * while erring the other way tells a departed merchant their data is gone
 * when it is not.
 */
export function verifyUnlearning(params: {
  merchantId: string;
  probes: MembershipProbe[];
  provenance: ProbeProvenance;
  materialAdvantagePp?: number;
}): UnlearningReport {
  const material = params.materialAdvantagePp ?? MATERIAL_ADVANTAGE_PP;
  const forgetProbes = params.probes.filter((p) => p.cohort === "forget");
  const controlProbes = params.probes.filter((p) => p.cohort === "control");

  const base = {
    merchantId: params.merchantId,
    provenance: params.provenance,
    caveat: FRAGILITY_CAVEAT,
  };

  if (
    forgetProbes.length < MIN_PROBES_PER_COHORT ||
    controlProbes.length < MIN_PROBES_PER_COHORT
  ) {
    return {
      ...base,
      forget: { n: forgetProbes.length, flaggedAsMember: 0 },
      control: { n: controlProbes.length, flaggedAsMember: 0 },
      attackerAdvantagePp: 0,
      thresholdUsed: null,
      ci95Pp: null,
      minimumDetectableEffectPp: null,
      verdict: "insufficient",
      reason: `Too few probes to test anything: ${forgetProbes.length} forget and ${controlProbes.length} control, against a floor of ${MIN_PROBES_PER_COHORT} each. This is a fact about the audit, not about the model.`,
    };
  }

  /**
   * Every observed confidence is a candidate cutoff. Sweeping the values that
   * actually occur is equivalent to sweeping the continuum, because the
   * attacker's decision only changes as the cutoff crosses a real score.
   */
  const thresholds = [...new Set(params.probes.map((p) => p.confidence))].sort((a, b) => a - b);

  let best:
    | { threshold: number; forget: ArmOutcome; control: ArmOutcome; advantage: number; falsePositive: number }
    | null = null;

  for (const threshold of thresholds) {
    const forget = arm(forgetProbes, threshold);
    const control = arm(controlProbes, threshold);

    /**
     * Degenerate cutoffs are skipped.
     *
     * A threshold below every observed score flags everything, and one above
     * them all flags nothing. Both give an advantage of exactly zero while
     * testing nothing whatsoever, and because ties are common — a model that
     * really has forgotten produces zero advantage at EVERY cutoff — the
     * sweep would otherwise settle on one of them and report a confident null
     * from a test that never discriminated at all.
     */
    const flagged = forget.converted + control.converted;
    if (flagged === 0 || flagged === forget.n + control.n) continue;

    const advantage = forget.converted / forget.n - control.converted / control.n;
    const falsePositive = control.converted / control.n;

    /**
     * Ties break toward the fewer false positives.
     *
     * Two cutoffs that give the attacker the same advantage are not equally
     * good attacks: the one that wrongly flags fewer unseen records is the
     * sharper instrument, and it is the one a real adversary would use.
     */
    const better =
      !best ||
      advantage > best.advantage ||
      (advantage === best.advantage && falsePositive < best.falsePositive);

    if (better) best = { threshold, forget, control, advantage, falsePositive };
  }

  if (!best) {
    return {
      ...base,
      forget: { n: forgetProbes.length, flaggedAsMember: 0 },
      control: { n: controlProbes.length, flaggedAsMember: 0 },
      attackerAdvantagePp: 0,
      thresholdUsed: null,
      ci95Pp: null,
      minimumDetectableEffectPp: null,
      verdict: "insufficient",
      reason:
        "Every probe carries the same confidence, so no cutoff separates the cohorts at all. The model was never actually interrogated — this is a fact about the probes, not about the model.",
    };
  }

  const { threshold, forget, control } = best;
  const lift = computeLift(forget, control);
  const power = assessPower(forget, control);
  const advantagePp = lift.absoluteLiftPp;

  const shaped = {
    ...base,
    forget: { n: forget.n, flaggedAsMember: forget.converted },
    control: { n: control.n, flaggedAsMember: control.converted },
    attackerAdvantagePp: advantagePp,
    thresholdUsed: threshold,
    ci95Pp: lift.ci95Pp,
    minimumDetectableEffectPp: power.minimumDetectableEffectPp,
  };

  if (lift.significant && advantagePp >= material) {
    return {
      ...shaped,
      verdict: "residual_influence",
      reason: `An attacker distinguishes forgotten records from unseen ones ${advantagePp.toFixed(1)}pp better than chance. The model still behaves as though it holds this merchant's data.`,
    };
  }

  const couldDetect =
    power.minimumDetectableEffectPp !== null && power.minimumDetectableEffectPp <= material;

  if (!couldDetect) {
    return {
      ...shaped,
      verdict: "insufficient",
      reason: `No residual influence found, but this audit could only have resolved an advantage of ${describeSensitivity(power.minimumDetectableEffectPp)}, coarser than the ${material}pp treated as material. Residual influence could be present and invisible to a test this size.`,
    };
  }

  /**
   * The strongest honest verdict available, and it is deliberately not "the
   * data is gone". Provenance caps it: a control set chosen by the party
   * being audited can be chosen to pass, and a clean result from evidence the
   * audited party selected is worth strictly less than one from evidence they
   * did not.
   */
  if (params.provenance === "platform") {
    return {
      ...shaped,
      verdict: "unverifiable_provenance",
      reason: `No residual influence detectable down to about ${power.minimumDetectableEffectPp!.toFixed(1)}pp — but the probes were supplied by the party being audited, who could have chosen a control set that passes. The measurement is sound; the evidence it ran on is not independent.`,
    };
  }

  return {
    ...shaped,
    verdict: "no_detectable_influence",
    reason: `No residual influence detectable down to about ${power.minimumDetectableEffectPp!.toFixed(1)}pp, on probes the auditor selected. This is the absence of evidence at a stated sensitivity, not evidence the data is gone.`,
  };
}
