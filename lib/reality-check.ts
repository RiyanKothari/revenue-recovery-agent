import { assessPower, computeLift, type ArmOutcome } from "./statistics";

/**
 * Reality Check — grading a certification against reality instead of against
 * a flattering simulator.
 *
 * ## The finding this rests on
 *
 * Agent platforms certify agents before publishing them, and pre-deployment
 * testing is done against simulated customers. A June 2026 study across 2,790
 * real sales conversations (arXiv 2606.20708) found that LLM-simulated
 * customers deliberate 75% of the time against 45% for real people, halve
 * expressed resistance for eventual non-buyers, and — the line that matters —
 * **never walk away**.
 *
 * So a certification process built on simulators systematically overstates
 * conversion and understates pushback. Worse, it does so unevenly: the bias
 * concentrates in the customers who would have declined, which is exactly the
 * population where a manipulative agent does its damage. An agent that bullies
 * reluctant people into buying looks *excellent* against a simulator that
 * cannot be bullied and cannot leave.
 *
 * ## What this does about it
 *
 * Compares what the simulator predicted against what the holdout actually
 * measured, per segment, and treats the difference as a property of the
 * *simulator* rather than of the agent. A simulator with a known bias is
 * usable — you can correct for it. One with an unknown bias is not, and
 * certifying against it is a ritual rather than a check.
 *
 * The holdout is the thing that makes this possible and it is the thing
 * almost nobody has. This codebase already has one.
 *
 * ## Three decisions worth knowing
 *
 * **Per segment, never in aggregate.** Aggregating is how this bias hides: a
 * headline gap can look tolerable while the segment that matters is wildly
 * off, because the well-modelled segments are also the larger ones.
 *
 * **The direction is not symmetric.** A simulator that *overstates*
 * conversion certifies an agent that will underperform in the field, which is
 * the failure the paper describes. One that understates is merely
 * conservative: it wastes opportunity and harms no customer. So only optimism
 * refuses certification. Pessimism is reported and forgiven.
 *
 * **Insufficient is a verdict.** A segment too small to resolve a material
 * gap can neither certify nor refuse, and saying so is the difference between
 * a check and a rubber stamp.
 */

/** A simulator-measured gap this size or larger is worth acting on. */
export const MATERIAL_FIDELITY_GAP_PP = 5;

/** Below this many observations the normal approximation is not trustworthy. */
export const MIN_ARM_FOR_FIDELITY = 30;

export interface SegmentEvidence {
  segment: string;
  /** What the simulator predicted: conversations run, and how many converted. */
  simulated: ArmOutcome;
  /**
   * What actually happened to real customers in the treated arm.
   *
   * The treated arm rather than the whole population, because the simulator
   * was predicting the effect of being treated. Comparing a simulation of
   * treatment against a mixture of treated and untreated people would measure
   * the holdout rate, not the simulator's fidelity.
   */
  measured: ArmOutcome;
}

export type FidelityVerdict = "calibrated" | "optimistic" | "pessimistic" | "insufficient";

export interface SegmentFidelity {
  segment: string;
  simulatedRate: number;
  measuredRate: number;
  /** Simulated minus measured, in percentage points. Positive is optimistic. */
  gapPp: number;
  ci95Pp: [number, number] | null;
  minimumDetectableEffectPp: number | null;
  verdict: FidelityVerdict;
  reason: string;
}

export interface CertificationResult {
  agent: string;
  segments: SegmentFidelity[];
  decision: "certified" | "refused" | "insufficient_evidence";
  summary: string;
}

function rate(arm: ArmOutcome): number {
  return arm.n === 0 ? 0 : arm.converted / arm.n;
}

/**
 * One segment's fidelity.
 *
 * `computeLift` is handed (simulated, measured) in that order, so a positive
 * gap means the simulator promised more than reality delivered. The sign
 * convention is load-bearing everywhere below.
 */
export function assessSegment(
  evidence: SegmentEvidence,
  materialGapPp = MATERIAL_FIDELITY_GAP_PP
): SegmentFidelity {
  const { segment, simulated, measured } = evidence;

  const lift = computeLift(simulated, measured);
  const power = assessPower(simulated, measured);
  const gapPp = lift.absoluteLiftPp;

  const base = {
    segment,
    simulatedRate: rate(simulated),
    measuredRate: rate(measured),
    gapPp,
    ci95Pp: lift.ci95Pp,
    minimumDetectableEffectPp: power.minimumDetectableEffectPp,
  };

  if (simulated.n < MIN_ARM_FOR_FIDELITY || measured.n < MIN_ARM_FOR_FIDELITY) {
    return {
      ...base,
      verdict: "insufficient",
      reason: `Too little evidence to judge: ${simulated.n} simulated against ${measured.n} measured, and below ${MIN_ARM_FOR_FIDELITY} the interval means nothing. This segment can neither certify nor refuse.`,
    };
  }

  const material = Math.abs(gapPp) >= materialGapPp;

  if (lift.significant && material && gapPp > 0) {
    return {
      ...base,
      verdict: "optimistic",
      reason: `The simulator predicted ${gapPp.toFixed(1)}pp more conversion than really happened. An agent graded here was graded on an easier population than it will meet.`,
    };
  }

  if (lift.significant && material && gapPp < 0) {
    return {
      ...base,
      verdict: "pessimistic",
      reason: `The simulator understated conversion by ${Math.abs(gapPp).toFixed(1)}pp. Conservative rather than dangerous: it wastes opportunity, and no customer is worse off for it.`,
    };
  }

  const couldSeeMaterial =
    power.minimumDetectableEffectPp !== null &&
    power.minimumDetectableEffectPp <= materialGapPp;

  if (couldSeeMaterial) {
    return {
      ...base,
      verdict: "calibrated",
      reason: `Simulated and measured agree within ${materialGapPp}pp, and this comparison could have resolved a gap of about ${power.minimumDetectableEffectPp!.toFixed(1)}pp — so the agreement is informative rather than merely unmeasured.`,
    };
  }

  return {
    ...base,
    verdict: "insufficient",
    reason: `No gap detected, but this comparison could only have resolved about ${power.minimumDetectableEffectPp?.toFixed(1) ?? "?"}pp, coarser than the ${materialGapPp}pp treated as material. A material gap could be present and invisible.`,
  };
}

/**
 * The certification decision.
 *
 * Refusal is driven by the *worst* segment, never by an average. Averaging is
 * precisely how the bias described in the paper survives a review: the
 * well-modelled segments are also the larger ones, so a mean fidelity gap is
 * dominated by exactly the customers the simulator gets right.
 */
export function certifyAgent(params: {
  agent: string;
  evidence: SegmentEvidence[];
  materialGapPp?: number;
}): CertificationResult {
  const segments = params.evidence.map((e) => assessSegment(e, params.materialGapPp));

  const optimistic = segments.filter((s) => s.verdict === "optimistic");
  const insufficient = segments.filter((s) => s.verdict === "insufficient");
  const pessimistic = segments.filter((s) => s.verdict === "pessimistic");

  if (segments.length === 0) {
    return {
      agent: params.agent,
      segments,
      decision: "insufficient_evidence",
      summary: "No segments were submitted, so there is nothing to certify against.",
    };
  }

  if (optimistic.length > 0) {
    const worst = optimistic.reduce((a, b) => (b.gapPp > a.gapPp ? b : a));
    return {
      agent: params.agent,
      segments,
      decision: "refused",
      summary:
        `Refused on ${optimistic.length} of ${segments.length} segment${segments.length === 1 ? "" : "s"}. ` +
        `Worst is "${worst.segment}", where the simulator promised ${worst.gapPp.toFixed(1)}pp more conversion than reality delivered. ` +
        "Certification granted here would be graded on an easier population than the agent will meet.",
    };
  }

  if (insufficient.length > 0) {
    return {
      agent: params.agent,
      segments,
      decision: "insufficient_evidence",
      summary:
        `${insufficient.length} of ${segments.length} segments could not be judged at all. ` +
        "No optimism was found, but absence of a finding in a comparison this size is not evidence of fidelity.",
    };
  }

  return {
    agent: params.agent,
    segments,
    decision: "certified",
    summary:
      `All ${segments.length} segments track reality within the material threshold` +
      (pessimistic.length > 0
        ? `, ${pessimistic.length} of them conservatively, which is the safe direction to be wrong in.`
        : ", and every comparison was large enough for that agreement to mean something."),
  };
}
