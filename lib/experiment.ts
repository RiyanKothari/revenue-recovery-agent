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
