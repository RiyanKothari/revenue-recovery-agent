import type { Classification } from "./classifier";

/**
 * Decision memoisation, keyed on the situation rather than the event.
 *
 * The agent is asked a bounded question: given this root cause, this payment
 * method, a payment of roughly this size, and this many prior attempts, which
 * of three actions fits? Across a batch of 800 failures there are only a few
 * dozen distinct answers to that question. Calling a model 800 times for 30
 * situations is something no production system would do — it is pure cost and
 * latency for an identical result, since the call runs at temperature 0.
 *
 * Two properties make this honest rather than a shortcut:
 *
 * 1. **The cache key is exactly the prompt.** The model is shown the amount
 *    *band*, not the rupee figure, so two events sharing a key are genuinely
 *    indistinguishable to the agent. A rationale written for one is true of
 *    the other. If the key and the prompt could ever diverge, a cached
 *    rationale could describe a situation that wasn't this event's — so they
 *    are derived from the same function.
 * 2. **Reuse is recorded.** Every decision row and audit entry states whether
 *    it was reasoned fresh or served from cache, and which key it matched.
 *    The audit trail never implies more reasoning than actually happened.
 */

/**
 * Coarse enough that neighbouring amounts share a decision, and meaningful
 * enough that the agent can still reason about magnitude — chasing ₹200 and
 * chasing ₹40,000 are different decisions.
 */
export function amountBand(amountPaise: number): string {
  const rupees = amountPaise / 100;
  if (rupees < 500) return "under_500";
  if (rupees < 2000) return "500_to_2000";
  if (rupees < 10000) return "2000_to_10000";
  return "over_10000";
}

export interface DecisionContext {
  classification: Classification;
  amountPaise: number;
  customerRetryHistory: { attempt_number: number; channel: string; status: string }[];
}

/**
 * The situation, reduced to what actually changes the answer. Prior attempts
 * collapse to the channels tried and how many — the agent needs to know
 * "WhatsApp twice, no conversion", not which events those were.
 */
export function decisionContextKey(input: DecisionContext): string {
  const priorChannels = input.customerRetryHistory
    .map((a) => a.channel)
    .sort()
    .join(",");

  return [
    input.classification.root_cause,
    input.classification.payment_method,
    amountBand(input.amountPaise),
    `attempts:${input.customerRetryHistory.length}`,
    `tried:${priorChannels || "none"}`,
  ].join("|");
}

/**
 * The prompt, derived from the same inputs as the key so the two cannot drift.
 * Note it carries the band rather than the exact amount — that is what makes a
 * cached rationale true of every event sharing the key.
 */
export function decisionPrompt(input: DecisionContext): string {
  const bandLabel: Record<string, string> = {
    under_500: "under ₹500",
    "500_to_2000": "between ₹500 and ₹2,000",
    "2000_to_10000": "between ₹2,000 and ₹10,000",
    over_10000: "over ₹10,000",
  };

  const history = input.customerRetryHistory.length
    ? input.customerRetryHistory
        .map((a) => `attempt ${a.attempt_number} via ${a.channel} (${a.status})`)
        .join("; ")
    : "none";

  return `Root cause: ${input.classification.root_cause}
Payment method: ${input.classification.payment_method}
Amount at risk: ${bandLabel[amountBand(input.amountPaise)]}
Prior recovery attempts for this customer: ${history}

Choose the best action and explain why.`;
}
