import { cheapestChannelCostPaise, type RecoveryPolicy } from "./policy";

/**
 * Is this recovery attempt worth making?
 *
 * Guardrails answer "are we allowed to act". This answers "should we" — and
 * it runs before the model is called, so an economically irrational action is
 * never in the model's reach. That makes the bounded-agent story quantitative
 * rather than a matter of prompt wording.
 *
 * The concrete failure it prevents: spending ₹50 of human escalation time
 * chasing a ₹40 failed payment. Doing that at scale destroys value while the
 * dashboard happily reports it as recovery, because gross recovery cannot see
 * cost.
 */

export interface ExpectedValueInput {
  amountPaise: number;
  /** P(recover | root cause, history) — see propensity.ts */
  probability: number;
  policy: RecoveryPolicy;
}

export interface ExpectedValueResult {
  proceed: boolean;
  expectedValuePaise: number;
  expectedRecoveryPaise: number;
  actionCostPaise: number;
  reason?: string;
}

export function evaluateExpectedValue(
  input: ExpectedValueInput
): ExpectedValueResult {
  const { amountPaise, probability, policy } = input;

  // Evaluated against the cheapest available channel: the model has not
  // chosen one yet, and if the best case does not clear the bar then no
  // channel does.
  const actionCostPaise = cheapestChannelCostPaise(policy);

  const expectedRecoveryPaise = amountPaise * policy.marginRate * probability;
  const expectedValuePaise = expectedRecoveryPaise - actionCostPaise;

  const proceed = expectedValuePaise > policy.minExpectedValuePaise;

  return {
    proceed,
    expectedValuePaise: Math.round(expectedValuePaise),
    expectedRecoveryPaise: Math.round(expectedRecoveryPaise),
    actionCostPaise,
    reason: proceed
      ? undefined
      : `negative_expected_value: expected ₹${(expectedRecoveryPaise / 100).toFixed(2)} against ₹${(actionCostPaise / 100).toFixed(2)} cost`,
  };
}
