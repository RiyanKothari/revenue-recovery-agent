/**
 * Recovery policy as versioned data rather than scattered constants.
 *
 * Every decision the pipeline makes records the policy version that governed
 * it, which is what makes the audit trail answer "why did it do that in
 * March?" rather than only "what did it do?". It is also what lets the replay
 * engine re-evaluate stored history under a different policy without calling
 * the model or sending anything.
 *
 * The policy lives in code (not a database table) deliberately: it is
 * reviewed, diffed and versioned like code, and a compliance change should
 * leave a commit behind. What goes in the database is the *version string* on
 * each decision, so history stays interpretable.
 */

export interface RecoveryPolicy {
  version: string;

  /** Hard stopping rules. */
  maxRetryAttempts: number;
  cooldownMinutes: number;

  /** Economic gate — an action must be worth taking, not merely allowed. */
  minExpectedValuePaise: number;
  marginRate: number; // share of a recovered payment that counts as value
  channelCostPaise: Record<string, number>;

  /** Share of eligible events deliberately left untreated, to measure lift. */
  holdoutPercent: number;

  /**
   * Not a number, and not tunable. Consent is the one rule with no
   * threshold to trade off, so the type system refuses to let a future
   * policy relax it.
   */
  dndRespected: true;
}

export const DEFAULT_POLICY: RecoveryPolicy = {
  version: "v1",

  maxRetryAttempts: 3,
  cooldownMinutes: 240, // 4 hours between nudges to the same customer

  minExpectedValuePaise: 0, // act only when expected value clears the cost
  marginRate: 1.0, // full recovered amount counts; drop below 1 to model contribution margin
  channelCostPaise: {
    // Rough Indian list prices, in paise. These do not need to be exact to be
    // useful — they need to be the right order of magnitude so the agent
    // stops chasing ₹40 failures with ₹50 of human time.
    whatsapp: 70, // ~₹0.70 per conversation, Meta pricing
    email: 5, // ~₹0.05
    human_escalation: 5000, // ~₹50 of an agent's time
  },

  holdoutPercent: 10,

  dndRespected: true,
};

/** The cheapest action available — used by the expected-value gate, which
 *  runs before the model has chosen a channel. If the best case is not worth
 *  it, no channel is. */
export function cheapestChannelCostPaise(policy: RecoveryPolicy): number {
  return Math.min(...Object.values(policy.channelCostPaise));
}
