import crypto from "node:crypto";
import type { RecoveryPolicy } from "./policy";

/**
 * The holdout arm — the difference between attributed recovery and measured
 * recovery.
 *
 * A slice of otherwise-eligible events is deliberately left untreated. Some
 * of those customers pay anyway, and that rate is the baseline the agent has
 * to beat. Without it, "we messaged 200 people and recovered ₹4.2L" credits
 * the agent for every customer who would have retried on their own, which is
 * most of the honest uncertainty in this whole project.
 *
 * Assignment is a pure function of the event id, so it survives webhook
 * retries, needs no stored state to be reproducible, and can be recomputed
 * from the audit log years later.
 */

export type Arm = "treated" | "control";

/**
 * Fixed, and deliberately not derived from the policy version. A constant
 * salt makes assignment monotonic in holdoutPercent — raising it from 10 to
 * 20 keeps the original control group and adds to it, rather than
 * reshuffling everyone and invalidating the comparison.
 */
const EXPERIMENT_SALT = "revenue-recovery-holdout-v1";

export function assignArm(revenueEventId: string, policy: RecoveryPolicy): Arm {
  if (policy.holdoutPercent <= 0) return "treated";
  if (policy.holdoutPercent >= 100) return "control";

  const digest = crypto
    .createHash("sha256")
    .update(`${EXPERIMENT_SALT}:${revenueEventId}`)
    .digest();

  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < policy.holdoutPercent ? "control" : "treated";
}

export interface ArmOutcome {
  /** Eligible events assigned to this arm. */
  n: number;
  /** How many of them were ultimately recovered. */
  converted: number;
  /** Total recovered, in paise. */
  recoveredPaise: number;
}

export interface LiftResult {
  treatedRate: number;
  controlRate: number;
  /** Percentage points, treated minus control. */
  absoluteLiftPp: number;
  relativeLift: number | null;
  /** 95% CI on the absolute lift, in percentage points. */
  ci95Pp: [number, number] | null;
  /**
   * Recovered money the agent can actually claim: what treated brought in,
   * minus what the same number of untreated events would have brought in on
   * their own.
   */
  incrementalPaise: number | null;
  /** Whether the CI excludes zero. */
  significant: boolean;
  /** Populated when the arms are too small to say anything. */
  caveat?: string;
}

/**
 * Two-proportion comparison with a normal-approximation interval.
 *
 * Deliberately reports a CI rather than a bare p-value: with a few hundred
 * events the honest answer is usually "somewhere between +4 and +21 points",
 * and collapsing that to "significant" hides how wide it still is.
 */
export function computeLift(treated: ArmOutcome, control: ArmOutcome): LiftResult {
  const empty: LiftResult = {
    treatedRate: 0,
    controlRate: 0,
    absoluteLiftPp: 0,
    relativeLift: null,
    ci95Pp: null,
    incrementalPaise: null,
    significant: false,
    caveat: "No control arm yet — lift cannot be measured.",
  };

  if (treated.n === 0 || control.n === 0) return empty;

  const treatedRate = treated.converted / treated.n;
  const controlRate = control.converted / control.n;
  const diff = treatedRate - controlRate;

  const se = Math.sqrt(
    (treatedRate * (1 - treatedRate)) / treated.n +
      (controlRate * (1 - controlRate)) / control.n
  );

  const margin = 1.96 * se;
  const ciLow = (diff - margin) * 100;
  const ciHigh = (diff + margin) * 100;

  // Value per untreated event is the baseline; anything above it is the
  // agent's doing. Using recovered-per-event rather than a conversion rate
  // times an average keeps varying ticket sizes honest.
  const baselinePerEvent = control.recoveredPaise / control.n;
  const incrementalPaise = Math.round(
    treated.recoveredPaise - baselinePerEvent * treated.n
  );

  // Under ~30 per arm the normal approximation is doing more work than the
  // data supports; say so rather than printing a confident interval.
  const underpowered = treated.n < 30 || control.n < 30;

  return {
    treatedRate,
    controlRate,
    absoluteLiftPp: diff * 100,
    relativeLift: controlRate > 0 ? diff / controlRate : null,
    ci95Pp: [ciLow, ciHigh],
    incrementalPaise,
    significant: ciLow > 0 || ciHigh < 0,
    caveat: underpowered
      ? `Small arms (treated n=${treated.n}, control n=${control.n}) — the interval is wide and this is directional, not conclusive.`
      : undefined,
  };
}


/**
 * The smallest effect this experiment could actually have detected.
 *
 * Without it, "not significant" is ambiguous in the worst way: it reads as
 * "the agent did not work" when it often means "this holdout was never large
 * enough to tell". A 10% holdout of four hundred events yields about thirty
 * control observations, and thirty observations cannot resolve a fifteen
 * point difference — the experiment was underpowered before it ran, which is
 * a fact about the design rather than a finding about the agent.
 *
 * Reporting the minimum detectable effect alongside the result turns a
 * confusing null into a specific, actionable statement: either the effect is
 * smaller than this, or the holdout needs to be bigger. Anyone reading the
 * panel can then tell which question the data has answered.
 *
 * Standard two-proportion power calculation at 80% power, alpha 0.05
 * two-sided, evaluated at the control arm's observed rate.
 */
const Z_ALPHA = 1.959964; // two-sided 95%
const Z_POWER = 0.8416212; // 80% power

export interface PowerResult {
  /** Smallest true difference detectable at 80% power, in percentage points. */
  minimumDetectableEffectPp: number | null;
  /** Control observations needed to detect the effect actually observed. */
  controlNeededForObserved: number | null;
  /** True when the arms are large enough to resolve the observed difference. */
  adequatelyPowered: boolean;
}

export function assessPower(treated: ArmOutcome, control: ArmOutcome): PowerResult {
  if (treated.n === 0 || control.n === 0) {
    return {
      minimumDetectableEffectPp: null,
      controlNeededForObserved: null,
      adequatelyPowered: false,
    };
  }

  const p = control.converted / control.n;
  const variance = p * (1 - p);

  // Harmonic mean of the arm sizes — the effective sample size when the two
  // are unequal, which they always are with a small holdout.
  const nEff = (2 * treated.n * control.n) / (treated.n + control.n);

  if (nEff <= 0 || variance <= 0) {
    return {
      minimumDetectableEffectPp: null,
      controlNeededForObserved: null,
      adequatelyPowered: false,
    };
  }

  const mde = (Z_ALPHA + Z_POWER) * Math.sqrt((2 * variance) / nEff);

  const observed = Math.abs(treated.converted / treated.n - p);
  const ratio = treated.n / control.n;

  // Control observations required to detect the difference actually seen,
  // holding the current allocation ratio.
  const needed =
    observed > 0
      ? Math.ceil(
          (((Z_ALPHA + Z_POWER) ** 2) * variance * (1 + 1 / ratio)) / observed ** 2
        )
      : null;

  return {
    minimumDetectableEffectPp: mde * 100,
    controlNeededForObserved: needed,
    adequatelyPowered: needed !== null && control.n >= needed,
  };
}
