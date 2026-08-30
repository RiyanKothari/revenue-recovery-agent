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

export function classify(input: ClassificationInput): Classification {
  // Precedence matters. Razorpay's error_code is a coarse bucket
  // (GATEWAY_ERROR, BAD_REQUEST_ERROR, SERVER_ERROR) while error_description
  // carries the actual reason. Matching them as one blob let the code shadow
  // the description — "GATEWAY_ERROR" + "Network connection error" classified
  // as gateway_error, because /(gateway|processing).?error/ hit the code
  // first and network_drop became unreachable. Specific beats generic:
  // description first, code only as a fallback.
  const rule =
    firstMatch(input.error_description ?? "") ?? firstMatch(input.error_code ?? "");

  if (rule) {
    return {
      root_cause: rule.cause,
      payment_method: input.payment_method ?? "unknown",
      is_recoverable: rule.recoverable,
    };
  }

  return {
    root_cause: "unknown",
    payment_method: input.payment_method ?? "unknown",
    is_recoverable: false, // fail closed: unknown failures go to human escalation, not automated retry
  };
}
