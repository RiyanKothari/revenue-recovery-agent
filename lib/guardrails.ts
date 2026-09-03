import { getDb, type RecoveryDb } from "./db";
import { DEFAULT_POLICY, type RecoveryPolicy } from "./policy";

/**
 * Guardrails run BEFORE the agent is even asked to decide anything, and
 * their result is a hard veto — the agent's tool-calling is scoped so it
 * physically cannot take an action a guardrail has blocked. This is what
 * "bounded" and "compliant escalation" mean in the submission bar: not a
 * prompt asking the LLM to behave, but code that doesn't let it do
 * otherwise.
 *
 * Every check fails CLOSED. An earlier version dropped the database error
 * from each query, which meant an outage made every guardrail evaluate to
 * "allowed" — a DND opt-out would have been nudged anyway. The data layer
 * now throws on infrastructure failure rather than returning a falsy value,
 * and each check below turns that throw into a refusal with a specific
 * reason. If we cannot prove an action is safe, we do not take it.
 */

/**
 * Only the operations the safety rules actually need. Narrow on purpose:
 * these are the rules that keep the agent from messaging people who asked
 * not to be messaged, and a small surface keeps them testable against
 * simulated failures.
 */
export type GuardrailDb = Pick<
  RecoveryDb,
  | "getConsent"
  | "countActionsForEvent"
  | "hasActionForCustomerSince"
  | "getEventPaymentId"
  | "hasDisputeFlag"
>;

export interface GuardrailResult {
  allowed: boolean;
  reason?: string; // populated when allowed = false, logged to audit trail
}

export async function checkGuardrails(
  customerId: string,
  revenueEventId: string,
  /**
   * When the payment failed — NOT when this check runs.
   *
   * Required rather than defaulted to now(), because a "now" default is what
   * made this wrong in the first place. Razorpay retries webhook deliveries
   * with backoff, so an event can be processed hours after the payment it
   * describes, and asking "was this customer contacted in the four hours
   * before *this moment*" answers a question about our server's clock rather
   * than the customer's experience. Under a delayed delivery the two windows
   * do not overlap at all: the guardrail holds perfectly while examining the
   * wrong four hours.
   *
   * Making it a parameter also means the cooldown is a pure function of
   * recorded times, which is what lets the replay engine reproduce it exactly.
   */
  eventTimeIso: string,
  db: GuardrailDb = getDb(),
  policy: RecoveryPolicy = DEFAULT_POLICY
): Promise<GuardrailResult> {
  // 1. Consent / DND — checked first, no exceptions.
  let consent: { dnd: boolean } | null;
  try {
    consent = await db.getConsent(customerId);
  } catch {
    return { allowed: false, reason: "guardrail_check_failed:consent" };
  }

  if (consent?.dnd) {
    return { allowed: false, reason: "customer_dnd_opt_out" };
  }

  // 2. Max retry attempts for this specific event.
  let attemptCount: number;
  try {
    attemptCount = await db.countActionsForEvent(revenueEventId);
  } catch {
    return { allowed: false, reason: "guardrail_check_failed:attempt_count" };
  }

  if (attemptCount >= policy.maxRetryAttempts) {
    return { allowed: false, reason: "max_retry_attempts_reached" };
  }

  // 3. Cooldown window since the last nudge to this customer, across events.
  // Measured backwards from when the payment failed, not from now.
  const eventTimeMs = new Date(eventTimeIso).getTime();
  if (!Number.isFinite(eventTimeMs)) {
    // An unreadable event time makes the window unknowable, and a guardrail
    // that cannot evaluate its own rule refuses.
    return { allowed: false, reason: "guardrail_check_failed:event_time" };
  }

  const cooldownCutoff = new Date(
    eventTimeMs - policy.cooldownMinutes * 60 * 1000
  ).toISOString();

  let recentlyContacted: boolean;
  try {
    recentlyContacted = await db.hasActionForCustomerSince(
      customerId,
      cooldownCutoff,
      eventTimeIso
    );
  } catch {
    return { allowed: false, reason: "guardrail_check_failed:cooldown" };
  }

  if (recentlyContacted) {
    return { allowed: false, reason: "cooldown_window_active" };
  }

  // 4. Refund/dispute kill-switch — if this event's payment was later
  // refunded or disputed, never nudge for it again.
  let paymentId: string | null;
  try {
    // The webhook inserts this row before calling us, so a missing or
    // unreadable event means our view of the world is wrong. Refuse.
    paymentId = await db.getEventPaymentId(revenueEventId);
  } catch {
    return { allowed: false, reason: "guardrail_check_failed:event_lookup" };
  }

  if (paymentId) {
    try {
      if (await db.hasDisputeFlag(revenueEventId)) {
        return { allowed: false, reason: "refund_or_dispute_flagged" };
      }
    } catch {
      // Both an error and a hit mean "do not nudge".
      return { allowed: false, reason: "refund_or_dispute_flagged" };
    }
  }

  return { allowed: true };
}

export const MAX_RETRY_ATTEMPTS = DEFAULT_POLICY.maxRetryAttempts;
export const COOLDOWN_MINUTES = DEFAULT_POLICY.cooldownMinutes;
