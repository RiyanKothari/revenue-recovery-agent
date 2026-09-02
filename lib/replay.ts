import { assignArm } from "./experiment";
import { evaluateExpectedValue } from "./expected-value";
import type { RecoveryPolicy } from "./policy";

/**
 * Counterfactual policy replay — "what would a different policy have done?"
 *
 * Every gate before the model is deterministic and every input it read was
 * written down, so the whole pre-model pipeline can be re-run over recorded
 * history under a different policy without calling the model, contacting
 * anyone, or touching a single row. That is the payoff for keeping the policy
 * as versioned data and recording the version on each decision: history stays
 * interpretable, and a compliance change can be costed *before* it ships
 * rather than discovered in next month's numbers.
 *
 * The honesty boundary, which is the whole reason this is careful rather than
 * clever:
 *
 *   - **Exact.** Which events a policy would act on, hold back, decline as
 *     unprofitable, or assign to the holdout. These are pure functions of
 *     recorded data, so replay reproduces them precisely.
 *
 *   - **Estimated.** How much money would have come back. Nobody knows
 *     whether a customer who was never contacted would have paid. The
 *     estimate applies the *measured* conversion rates from the arms that
 *     actually ran, which assumes newly-eligible events behave like the ones
 *     already treated — a real assumption, and one that gets weaker the
 *     further the new policy strays from the old.
 *
 * Reporting the second as confidently as the first would turn a genuine
 * planning tool into a fabrication, so the result keeps them in separate
 * fields and names the assumption.
 */

export interface ReplayEvent {
  id: string;
  amountPaise: number;
  /** Whether the customer had opted out. Consent is never re-litigated. */
  dnd: boolean;
  /** Probability estimated for this event when it was first processed. */
  recoveryProbability: number;
  /** Prior recovery actions against this event, for the retry ceiling. */
  priorAttempts: number;
  /**
   * Minutes since this customer was last contacted at the moment this event
   * arrived, or null if they never had been. Precomputed by the caller
   * because it is a join, not a judgment.
   */
  minutesSinceLastContact: number | null;
  /** What actually happened, used only to calibrate the estimate. */
  recovered: boolean;
  recoveredPaise: number;
}

export type ReplayDisposition =
  | "acted"
  | "blocked_dnd"
  | "blocked_retry_ceiling"
  | "blocked_cooldown"
  | "declined_negative_ev"
  | "holdout_control";

export interface ReplayOutcome {
  eventId: string;
  disposition: ReplayDisposition;
}

export interface ReplayTotals {
  acted: number;
  blocked_dnd: number;
  blocked_retry_ceiling: number;
  blocked_cooldown: number;
  declined_negative_ev: number;
  holdout_control: number;
}

export interface ReplayResult {
  policyVersion: string;
  totals: ReplayTotals;
  /** Rupees the acted-on events represent, at risk. */
  actedAtRiskPaise: number;
  outcomes: ReplayOutcome[];
}

/**
 * Runs one event through the deterministic gates in the pipeline's own order.
 *
 * The order matters and is not an implementation detail: consent first
 * because it has no exceptions, then the hard stopping rules, then the
 * economic gate, then the holdout. Re-ordering would change which reason an
 * event is attributed to even when the outcome is identical — and the reason
 * is what the Policy Lab is being asked about.
 */
export function replayEvent(event: ReplayEvent, policy: RecoveryPolicy): ReplayDisposition {
  // Consent is not a tunable. `dndRespected: true` is a literal type, so a
  // policy that relaxes it cannot be constructed — but replaying it as a
  // no-op anyway would be a quiet way to lose the rule, so it is checked.
  if (event.dnd) return "blocked_dnd";

  if (event.priorAttempts >= policy.maxRetryAttempts) return "blocked_retry_ceiling";

  if (
    event.minutesSinceLastContact !== null &&
    event.minutesSinceLastContact < policy.cooldownMinutes
  ) {
    return "blocked_cooldown";
  }

  const ev = evaluateExpectedValue({
    amountPaise: event.amountPaise,
    probability: event.recoveryProbability,
    policy,
  });

  if (!ev.proceed) return "declined_negative_ev";

  // Assignment is a pure function of the event id and the holdout size, so a
  // replay reproduces the same split the live pipeline would have chosen.
  return assignArm(event.id, policy) === "control" ? "holdout_control" : "acted";
}

export function replayPolicy(events: ReplayEvent[], policy: RecoveryPolicy): ReplayResult {
  const totals: ReplayTotals = {
    acted: 0,
    blocked_dnd: 0,
    blocked_retry_ceiling: 0,
    blocked_cooldown: 0,
    declined_negative_ev: 0,
    holdout_control: 0,
  };

  const outcomes: ReplayOutcome[] = [];
  let actedAtRiskPaise = 0;

  for (const event of events) {
    const disposition = replayEvent(event, policy);
    totals[disposition] += 1;
    if (disposition === "acted") actedAtRiskPaise += event.amountPaise;
    outcomes.push({ eventId: event.id, disposition });
  }

  return { policyVersion: policy.version, totals, actedAtRiskPaise, outcomes };
}

// --- comparison ------------------------------------------------------------

export interface RecoveryEstimate {
  /**
   * Rupees the counterfactual policy would be expected to recover, using the
   * conversion rates the live arms actually measured.
   */
  estimatedRecoveredPaise: number;
  /** The rates the estimate leans on, so the reader can judge it. */
  treatedConversionRate: number;
  controlConversionRate: number;
  /** False when the live batch has no arm to calibrate against. */
  calibrated: boolean;
  assumption: string;
}

export interface PolicyComparison {
  baseline: ReplayResult;
  candidate: ReplayResult;
  /** Exact, per disposition: candidate minus baseline. */
  deltas: ReplayTotals;
  estimate: RecoveryEstimate | null;
}

/**
 * Estimates what a replayed policy would have recovered.
 *
 * Deliberately calibrated on the *observed* arms rather than on an assumed
 * uplift. If the live batch treated 274 events and 103 converted, this uses
 * 37.6% — a number the system measured — instead of a figure chosen to make
 * the new policy look good. When there is no arm to calibrate against it
 * returns `calibrated: false` and zero rather than inventing a rate, because
 * a made-up baseline would make every counterfactual meaningless in a way
 * nothing downstream could detect.
 */
export function estimateRecovery(
  result: ReplayResult,
  observed: {
    treated: { n: number; converted: number; recoveredPaise: number };
    control: { n: number; converted: number; recoveredPaise: number };
  }
): RecoveryEstimate {
  const treatedRate = observed.treated.n ? observed.treated.converted / observed.treated.n : 0;
  const controlRate = observed.control.n ? observed.control.converted / observed.control.n : 0;

  const calibrated = observed.treated.n > 0;

  // Average recovered value per conversion, from what actually came back.
  // Using the at-risk amount instead would ignore partial recoveries and
  // overstate every counterfactual by however much was never collected.
  const totalConverted = observed.treated.converted + observed.control.converted;
  const totalRecovered = observed.treated.recoveredPaise + observed.control.recoveredPaise;
  const perConversionPaise = totalConverted ? totalRecovered / totalConverted : 0;

  const expectedConversions =
    result.totals.acted * treatedRate + result.totals.holdout_control * controlRate;

  return {
    estimatedRecoveredPaise: Math.round(expectedConversions * perConversionPaise),
    treatedConversionRate: treatedRate,
    controlConversionRate: controlRate,
    calibrated,
    assumption: calibrated
      ? "Applies the conversion rates measured on the live arms to the counterfactual population. Assumes newly-eligible events behave like those already treated."
      : "No treated arm to calibrate against — no recovery estimate is possible.",
  };
}

export function comparePolicies(
  events: ReplayEvent[],
  baseline: RecoveryPolicy,
  candidate: RecoveryPolicy,
  observed?: {
    treated: { n: number; converted: number; recoveredPaise: number };
    control: { n: number; converted: number; recoveredPaise: number };
  }
): PolicyComparison {
  const baselineResult = replayPolicy(events, baseline);
  const candidateResult = replayPolicy(events, candidate);

  const keys = Object.keys(baselineResult.totals) as (keyof ReplayTotals)[];
  const deltas = keys.reduce((acc, key) => {
    acc[key] = candidateResult.totals[key] - baselineResult.totals[key];
    return acc;
  }, {} as ReplayTotals);

  return {
    baseline: baselineResult,
    candidate: candidateResult,
    deltas,
    estimate: observed ? estimateRecovery(candidateResult, observed) : null,
  };
}
