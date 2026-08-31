import type { RootCause } from "./classifier";

/**
 * How likely is this failure to be recovered if we act?
 *
 * Starts from priors grounded in what each root cause physically means, then
 * lets the pipeline's own observed outcomes take over as evidence
 * accumulates. This is the feedback loop: the agent's economics get sharper
 * the longer it runs, using the outcomes table it already maintains.
 *
 * Beta-binomial smoothing, so a cause with two observations doesn't swing the
 * estimate to 0% or 100%. As trials grow the prior's influence decays to
 * nothing on its own — no thresholds to tune.
 */

export interface PropensityPrior {
  alpha: number; // pseudo-successes
  beta: number; // pseudo-failures
}

/**
 * Priors reflect mechanism, not measurement:
 *  - transient infrastructure failures (timeout, gateway, network) had a
 *    valid payment method and usually succeed on a retry
 *  - insufficient funds depends on the customer's balance changing
 *  - declines and bad credentials need the customer to actively fix something
 *
 * Weights are deliberately light (~10 pseudo-observations) so roughly 30 real
 * outcomes dominate them.
 */
const PRIORS: Record<string, PropensityPrior> = {
  bank_timeout: { alpha: 6, beta: 4 },
  gateway_error: { alpha: 6, beta: 4 },
  network_drop: { alpha: 6, beta: 4 },
  insufficient_funds: { alpha: 3, beta: 7 },
  card_declined: { alpha: 2, beta: 8 },
  invalid_credentials: { alpha: 2, beta: 8 },
  unknown: { alpha: 1, beta: 9 },
};

const FALLBACK_PRIOR: PropensityPrior = { alpha: 2, beta: 8 };

export function priorFor(rootCause: RootCause | string): PropensityPrior {
  return PRIORS[rootCause] ?? FALLBACK_PRIOR;
}

export interface ObservedStats {
  trials: number;
  successes: number;
}

/**
 * Posterior mean of the recovery probability.
 *
 * Guards against malformed inputs rather than trusting them: successes above
 * trials, or negatives, would otherwise produce a probability outside [0,1]
 * and silently corrupt every downstream expected-value calculation.
 */
export function estimateRecoveryProbability(
  rootCause: RootCause | string,
  observed: ObservedStats = { trials: 0, successes: 0 }
): number {
  const prior = priorFor(rootCause);

  const trials = Math.max(0, observed.trials);
  const successes = Math.min(Math.max(0, observed.successes), trials);

  const probability =
    (successes + prior.alpha) / (trials + prior.alpha + prior.beta);

  return Math.min(1, Math.max(0, probability));
}

/**
 * Rolls observed outcomes up by root cause. Takes plain rows so it stays a
 * pure function — the caller owns the query.
 */
export function tallyByRootCause(
  rows: { root_cause: string | null; recovered: boolean }[]
): Record<string, ObservedStats> {
  const tally: Record<string, ObservedStats> = {};

  for (const row of rows) {
    const key = row.root_cause ?? "unknown";
    tally[key] ??= { trials: 0, successes: 0 };
    tally[key].trials += 1;
    if (row.recovered) tally[key].successes += 1;
  }

  return tally;
}
