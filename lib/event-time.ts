/**
 * When did this payment actually fail?
 *
 * Not the same question as "when did the webhook arrive", and the difference
 * is load-bearing. Razorpay retries a failed delivery with backoff, so an
 * event can reach us minutes or hours after the payment it describes — and
 * every time-based rule in this pipeline (the cooldown window, time-to-
 * recovery, the whole ordering of the ledger) would silently key off our
 * server's clock rather than the customer's timeline.
 *
 * The concrete failure: a delivery delayed past the cooldown window makes the
 * event look freshly arrived, and the customer gets a second nudge inside the
 * window the rule exists to protect. The guardrail holds perfectly and still
 * produces the outcome it was written to prevent, because it was asked about
 * the wrong moment.
 *
 * Razorpay's payment entity carries `created_at` as unix seconds, so the
 * right answer is already in the payload.
 *
 * It is also *attacker-influenced input*, which is why this is a module with
 * tests rather than an inline `new Date(entity.created_at * 1000)`. A forged
 * or corrupt timestamp could otherwise backdate an event out of its own
 * cooldown window — turning a convenience into a way to defeat the rule. So
 * anything implausible is refused and the receipt time stands.
 */

/** Reject timestamps outside this window, in days either side of now. */
const MAX_PAST_DAYS = 90;
const MAX_FUTURE_MINUTES = 5; // small allowance for clock skew

export interface EventTimeResult {
  /** ISO string to record, or null to let the database default to now(). */
  receivedAt: string | null;
  /** Why a supplied timestamp was refused, for the audit trail. */
  rejected?: string;
}

export function resolveEventTime(
  createdAt: unknown,
  now: Date = new Date()
): EventTimeResult {
  if (createdAt === null || createdAt === undefined) return { receivedAt: null };

  const seconds = Number(createdAt);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { receivedAt: null, rejected: "created_at is not a positive number" };
  }

  const millis = seconds * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return { receivedAt: null, rejected: "created_at is not a valid time" };
  }

  const nowMs = now.getTime();

  if (millis > nowMs + MAX_FUTURE_MINUTES * 60_000) {
    // A future timestamp would sort to the top of the ledger and sit outside
    // every backward-looking window.
    return { receivedAt: null, rejected: "created_at is in the future" };
  }

  if (millis < nowMs - MAX_PAST_DAYS * 86_400_000) {
    // Far-past values are the shape a backdating attempt takes: old enough to
    // fall outside any cooldown window.
    return { receivedAt: null, rejected: `created_at is more than ${MAX_PAST_DAYS} days old` };
  }

  return { receivedAt: date.toISOString() };
}
