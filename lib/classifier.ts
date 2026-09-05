/**
 * Deterministic root-cause classifier.
 *
 * Deliberately NOT an LLM call — this is the hard-constraint floor the
 * agent reasons within (see decision-engine.ts). Categories are aligned to
 * how Razorpay's own Optimizer / Success-Rate dashboard breaks failures
 * down: by payment method (Cards, UPI, Netbanking) and by reason, not an
 * invented taxonomy.
 *
 * Source for error_code/error_description shape:
 * https://razorpay.com/docs/payments/payment-webhook-payload/
 */

export type RootCause =
  | "insufficient_funds"
  | "bank_timeout"
  | "card_declined"
  | "gateway_error"
  | "network_drop"
  | "invalid_credentials"
  | "unknown";

export interface ClassificationInput {
  error_code?: string | null;
  error_description?: string | null;
  payment_method?: string | null;

  /**
   * Razorpay's STRUCTURED error taxonomy, which real payloads carry and this
   * classifier originally ignored.
   *
   * Found by pointing it at a genuine failed payment. The synthetic batch was
   * shaped by our own generator, which emitted only error_code and a prose
   * error_description — so the classifier was written to parse prose, and
   * every rule was tuned against sentences we had written ourselves. A real
   * Razorpay failure arrives as:
   *
   *   error_code:        "BAD_REQUEST_ERROR"
   *   error_description: "Payment failed"      <- generic, carries nothing
   *   error_reason:      "payment_failed"
   *   error_source:      "gateway"             <- the actual signal
   *   error_step:        "payment_authorization"
   *
   * The description a human would read is the least informative field in the
   * payload, and it was the only one being read. The event classified as
   * unknown and went to human review — correct behaviour on the information
   * available, and the wrong information to have been looking at.
   *
   * These are enumerated values from Razorpay's own documentation, so reading
   * them is not guessing. It is using signal that was being discarded.
   */
  error_reason?: string | null;
  error_source?: string | null;
  error_step?: string | null;
}

export interface Classification {
  root_cause: RootCause;
  payment_method: string;
  is_recoverable: boolean; // false = don't even hand this to the agent (e.g. fraud-flagged)
}

const RULES: Array<{ match: RegExp; cause: RootCause; recoverable: boolean }> = [
  { match: /insufficient.?funds/i, cause: "insufficient_funds", recoverable: true },
  { match: /(timeout|timed.?out)/i, cause: "bank_timeout", recoverable: true },
  { match: /(declined|do.?not.?honou?r)/i, cause: "card_declined", recoverable: true },
  { match: /(gateway|processing).?error/i, cause: "gateway_error", recoverable: true },
  { match: /(network|connection).?(error|drop)/i, cause: "network_drop", recoverable: true },
  { match: /(invalid.?(card|cvv|expiry)|authentication.?failed)/i, cause: "invalid_credentials", recoverable: true },
];

function firstMatch(text: string) {
  if (!text.trim()) return undefined;
  return RULES.find((rule) => rule.match.test(text));
}

/**
 * Razorpay's `error_reason` is an enumerated value, not prose, so it maps
 * directly rather than being pattern-matched. Listed explicitly: a reason
 * this table has not been taught is left to fall through to the rules and
 * then to `unknown`, rather than being approximated by the nearest entry.
 */
const REASON_MAP: Record<string, { cause: RootCause; recoverable: boolean }> = {
  insufficient_funds: { cause: "insufficient_funds", recoverable: true },
  payment_failed: { cause: "gateway_error", recoverable: true },
  card_declined: { cause: "card_declined", recoverable: true },
  incorrect_otp: { cause: "invalid_credentials", recoverable: true },
  invalid_otp: { cause: "invalid_credentials", recoverable: true },
  payment_timeout: { cause: "bank_timeout", recoverable: true },
  gateway_error: { cause: "gateway_error", recoverable: true },
  network_error: { cause: "network_drop", recoverable: true },
  invalid_card: { cause: "invalid_credentials", recoverable: true },
  expired_card: { cause: "invalid_credentials", recoverable: true },
  // Deliberately NOT recoverable — chasing a payment the issuer suspects is
  // fraudulent is the one automated action that could do real harm.
  fraudulent_payment: { cause: "unknown", recoverable: false },
  suspected_fraud: { cause: "unknown", recoverable: false },
};

/**
 * Where the failure happened, used only when the reason is unrecognised.
 *
 * Coarser than `error_reason` and treated as such: it establishes that the
 * failure was infrastructural rather than a decision by the issuer, which is
 * enough to know a retry is worth attempting without claiming to know why.
 */
const SOURCE_MAP: Record<string, { cause: RootCause; recoverable: boolean }> = {
  gateway: { cause: "gateway_error", recoverable: true },
  network: { cause: "network_drop", recoverable: true },
  bank: { cause: "bank_timeout", recoverable: true },
  issuer: { cause: "card_declined", recoverable: true },
  // A failure the customer caused (wrong details, abandoned auth) is
  // recoverable by definition — they can try again.
  customer: { cause: "invalid_credentials", recoverable: true },
};

export function classify(input: ClassificationInput): Classification {
  // Precedence matters. Razorpay's error_code is a coarse bucket
  // (GATEWAY_ERROR, BAD_REQUEST_ERROR, SERVER_ERROR) while error_description
  // carries the actual reason. Matching them as one blob let the code shadow
  // the description — "GATEWAY_ERROR" + "Network connection error" classified
  // as gateway_error, because /(gateway|processing).?error/ hit the code
  // first and network_drop became unreachable. Specific beats generic:
  // description first, code only as a fallback.
  /**
   * Structured fields first, prose second.
   *
   * error_reason is an enumerated value from Razorpay; error_description is
   * a sentence written for a human. Reading the sentence first meant a real
   * payload whose description is the single word "Payment failed" classified
   * as unknown, while the field that actually named the cause sat unread two
   * keys away.
   */
  const structured =
    REASON_MAP[(input.error_reason ?? "").toLowerCase()] ??
    undefined;

  if (structured) {
    return {
      root_cause: structured.cause,
      payment_method: input.payment_method ?? "unknown",
      is_recoverable: structured.recoverable,
    };
  }

  const rule =
    firstMatch(input.error_description ?? "") ?? firstMatch(input.error_code ?? "");

  if (rule) {
    return {
      root_cause: rule.cause,
      payment_method: input.payment_method ?? "unknown",
      is_recoverable: rule.recoverable,
    };
  }

  /**
   * Last resort before giving up: where the failure occurred. Deliberately
   * after the prose rules, because it says only that something broke and not
   * what — enough to justify a retry, not enough to justify a claim.
   */
  const bySource = SOURCE_MAP[(input.error_source ?? "").toLowerCase()];
  if (bySource) {
    return {
      root_cause: bySource.cause,
      payment_method: input.payment_method ?? "unknown",
      is_recoverable: bySource.recoverable,
    };
  }

  return {
    root_cause: "unknown",
    payment_method: input.payment_method ?? "unknown",
    is_recoverable: false, // fail closed: unknown failures go to human escalation, not automated retry
  };
}
