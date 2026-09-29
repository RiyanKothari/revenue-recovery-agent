import type { CertificationResult, SegmentFidelity } from "./reality-check";

/**
 * Turning a measured fidelity gap into a usable simulator.
 *
 * ## The half that was missing
 *
 * `reality-check.ts` measures how far a simulator's predictions sit from what
 * a holdout actually recorded, and refuses to certify an agent graded on a
 * flattering one. That is the diagnosis. This is the treatment.
 *
 * A simulator with a *known* bias is not useless — it is a measuring
 * instrument with a calibration curve, which is how every real instrument
 * works. What makes it unusable is an *unknown* bias. So once the gap per
 * segment is measured, future predictions from that simulator can be
 * corrected by it, and the corrected number is worth something the raw one
 * never was.
 *
 * ## Why it corrects per segment and refuses to pool
 *
 * The finding this rests on (arXiv 2606.20708) is not that simulators are
 * uniformly optimistic. It is that they are optimistic *unevenly*: they halve
 * expressed resistance for eventual non-buyers and never walk away, so the
 * error concentrates in the customers who would have declined. A single
 * global correction factor would be dominated by the well-modelled segments,
 * undercorrect exactly where the bias lives, and leave the certification
 * looking rigorous while remaining wrong in the one place it matters.
 *
 * ## The rule that keeps this from becoming astrology
 *
 * **A segment is corrected only where the evidence could have resolved the
 * correction.** Reality Check already reports `insufficient` for comparisons
 * too small to judge, and applying a correction derived from such a segment
 * would be fitting to noise and then presenting the result as calibrated —
 * strictly worse than leaving it uncorrected, because it launders a guess
 * into a number.
 *
 * So corrections carry their own provenance. An uncorrected segment says so,
 * and a caller can tell a prediction that has been grounded in measurement
 * from one that is still raw.
 */

export type CorrectionBasis = "measured" | "uncorrected";

export interface SegmentCorrection {
  segment: string;
  /**
   * Percentage points to subtract from a raw simulated rate.
   *
   * Positive means the simulator runs hot and predictions should come down.
   * Zero with basis `uncorrected` is not the same as zero with basis
   * `measured`: the first means we do not know, the second means we looked
   * and found no bias.
   */
  adjustmentPp: number;
  basis: CorrectionBasis;
  /** The MDE of the comparison this came from, when there was one. */
  resolvedToPp: number | null;
  reason: string;
}

export interface Calibration {
  agent: string;
  corrections: SegmentCorrection[];
  /** Segments with a measured correction, over segments seen. */
  coverage: { corrected: number; total: number };
  summary: string;
}

/**
 * Builds a calibration from a certification result.
 *
 * Takes the whole `CertificationResult` rather than a list of gaps, because
 * the verdicts are what decide whether each gap may be used at all, and
 * passing the numbers without them would make it possible to calibrate
 * against a segment Reality Check had already refused to judge.
 */
export function buildCalibration(certification: CertificationResult): Calibration {
  const corrections = certification.segments.map(toCorrection);
  const corrected = corrections.filter((c) => c.basis === "measured").length;

  return {
    agent: certification.agent,
    corrections,
    coverage: { corrected, total: corrections.length },
    summary:
      corrected === 0
        ? "No segment had evidence strong enough to calibrate against. This simulator's bias is still unknown, which is the state that makes it unusable for certification."
        : `${corrected} of ${corrections.length} segments calibrated against measured outcomes. The rest are passed through uncorrected and say so.`,
  };
}

function toCorrection(segment: SegmentFidelity): SegmentCorrection {
  if (segment.verdict === "insufficient") {
    /**
     * The refusal that keeps this honest. A correction derived from a
     * comparison that could not resolve it is a guess, and applying it would
     * launder that guess into a number with a decimal point on it.
     */
    return {
      segment: segment.segment,
      adjustmentPp: 0,
      basis: "uncorrected",
      resolvedToPp: segment.minimumDetectableEffectPp,
      reason:
        "Not calibrated: the comparison could not resolve a gap of this size, so any correction would be fitted to noise.",
    };
  }

  if (segment.verdict === "calibrated") {
    return {
      segment: segment.segment,
      adjustmentPp: 0,
      basis: "measured",
      resolvedToPp: segment.minimumDetectableEffectPp,
      reason:
        "No correction needed. Simulated and measured agreed, on a comparison large enough for the agreement to be informative.",
    };
  }

  // Optimistic or pessimistic: the measured gap IS the correction.
  return {
    segment: segment.segment,
    adjustmentPp: segment.gapPp,
    basis: "measured",
    resolvedToPp: segment.minimumDetectableEffectPp,
    reason:
      segment.gapPp > 0
        ? `The simulator ran ${segment.gapPp.toFixed(1)}pp hot here against real outcomes, so predictions for this segment are brought down by that much.`
        : `The simulator ran ${Math.abs(segment.gapPp).toFixed(1)}pp cold here, so predictions for this segment are brought up by that much.`,
  };
}

export interface CorrectedPrediction {
  segment: string;
  rawRate: number;
  correctedRate: number;
  basis: CorrectionBasis;
  /**
   * Whether this number may be used to certify an agent.
   *
   * False for uncorrected segments. A prediction whose error is unmeasured
   * cannot support a claim about an agent's real-world behaviour, and saying
   * so here is what stops the calibration layer from quietly restoring the
   * problem it was built to fix.
   */
  usableForCertification: boolean;
  note: string;
}

/**
 * Applies a calibration to a fresh simulator prediction.
 *
 * Clamped to [0, 1], because a correction large enough to push a rate outside
 * that range is telling you the simulator and reality disagree about more
 * than a percentage — and returning a negative conversion rate would carry
 * that nonsense into whatever reads it next.
 */
export function applyCalibration(
  prediction: { segment: string; rawRate: number },
  calibration: Calibration
): CorrectedPrediction {
  const correction = calibration.corrections.find((c) => c.segment === prediction.segment);

  if (!correction) {
    /**
     * A segment the calibration has never seen. Not an error — populations
     * change and new segments appear — but emphatically not certifiable,
     * because nothing about this simulator's behaviour here has been
     * observed.
     */
    return {
      segment: prediction.segment,
      rawRate: prediction.rawRate,
      correctedRate: prediction.rawRate,
      basis: "uncorrected",
      usableForCertification: false,
      note: "This segment does not appear in the calibration, so the simulator's error here has never been measured.",
    };
  }

  const corrected = Math.min(
    1,
    Math.max(0, prediction.rawRate - correction.adjustmentPp / 100)
  );

  return {
    segment: prediction.segment,
    rawRate: prediction.rawRate,
    correctedRate: corrected,
    basis: correction.basis,
    usableForCertification: correction.basis === "measured",
    note: correction.reason,
  };
}
