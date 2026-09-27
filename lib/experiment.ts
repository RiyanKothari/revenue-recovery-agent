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

/**
 * Re-exported so existing importers keep working. The statistics live in
 * `lib/statistics.ts`, which has no Node-only dependencies and is therefore
 * safe to import from the browser.
 */
export {
  computeLift,
  assessPower,
  type ArmOutcome,
  type LiftResult,
  type PowerResult,
} from "./statistics";
