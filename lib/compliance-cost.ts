import type { RecoveryPolicy } from "./policy";

/**
 * What the stopping rules cost.
 *
 * Every guardrail that fires prevents a recovery attempt, and some of those
 * attempts would have worked. That foregone revenue is the price of the
 * safety rules — and stating it is more credible than pretending safety is
 * free. It also reframes the exceptions list: those aren't failures, they're
 * a bill the system pays on purpose, itemised.
 *
 * Crucially this is an ESTIMATE, not a measurement. It uses the learned
 * recovery propensity to guess what a blocked event would have returned, and
 * a blocked event by definition has no outcome to check against. Measured
 * lift (the holdout) and estimated cost (this) must never be presented as
 * the same kind of number — see the `basis` field, which the UI surfaces.
 */

export type StopCategory =
  | "compliance" // consent, cooldown, retry ceiling, disputes — the rules
  | "measurement" // holdout control — the price of knowing whether it works
  | "economics" // deliberately unprofitable to chase
  | "degraded" // a safety check could not be evaluated, so we refused
  | "unrecoverable"; // nothing to chase — unrecognised or non-recoverable

const CATEGORIES: Record<string, StopCategory> = {
  customer_dnd_opt_out: "compliance",
  cooldown_window_active: "compliance",
  max_retry_attempts_reached: "compliance",
  refund_or_dispute_flagged: "compliance",
  holdout_control: "measurement",
  negative_expected_value: "economics",
  not_recoverable_or_unknown_cause: "unrecoverable",
  agent_returned_unusable_decision: "degraded",
};

export function categorise(reason: string): StopCategory {
  if (reason.startsWith("guardrail_check_failed")) return "degraded";
  return CATEGORIES[reason] ?? "compliance";
}

export interface BlockedEvent {
  revenue_event_id: string;
  reason: string;
  amount_paise: number;
  root_cause: string | null;
}

export interface CostLine {
  count: number;
  atRiskPaise: number;
  /** Estimated recovery foregone by not acting. */
  foregonePaise: number;
}

export interface ComplianceCostReport {
  basis: "estimated";
  byReason: Record<string, CostLine & { category: StopCategory }>;
  byCategory: Record<StopCategory, CostLine>;
  totalForegonePaise: number;
  note: string;
}

const EMPTY_LINE = (): CostLine => ({ count: 0, atRiskPaise: 0, foregonePaise: 0 });

export function estimateComplianceCost(
  blocked: BlockedEvent[],
  probabilityFor: (rootCause: string) => number,
  policy: RecoveryPolicy
): ComplianceCostReport {
  const byReason: ComplianceCostReport["byReason"] = {};
  const byCategory: Record<StopCategory, CostLine> = {
    compliance: EMPTY_LINE(),
    measurement: EMPTY_LINE(),
    economics: EMPTY_LINE(),
    degraded: EMPTY_LINE(),
    unrecoverable: EMPTY_LINE(),
  };

  for (const event of blocked) {
    const category = categorise(event.reason);
    const probability = probabilityFor(event.root_cause ?? "unknown");
    const foregone = Math.round(
      event.amount_paise * policy.marginRate * probability
    );

    byReason[event.reason] ??= { ...EMPTY_LINE(), category };
    byReason[event.reason].count += 1;
    byReason[event.reason].atRiskPaise += event.amount_paise;
    byReason[event.reason].foregonePaise += foregone;

    byCategory[category].count += 1;
    byCategory[category].atRiskPaise += event.amount_paise;
    byCategory[category].foregonePaise += foregone;
  }

  // The economics bucket is excluded from the headline: those events were
  // skipped precisely because the expected recovery didn't cover the cost of
  // trying, so counting them as a loss would double-count a decision that was
  // already correct on its own terms.
  const totalForegonePaise =
    byCategory.compliance.foregonePaise +
    byCategory.measurement.foregonePaise +
    byCategory.degraded.foregonePaise;

  return {
    basis: "estimated",
    byReason,
    byCategory,
    totalForegonePaise,
    note: "Estimated from learned recovery propensity — blocked events have no outcome to measure against. Not comparable to the holdout's measured lift.",
  };
}
