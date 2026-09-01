import { getDb } from "./db";
import type { RetryAttempt } from "./db";

export type { RetryAttempt };

/**
 * Prior recovery attempts, read back out of recovery_actions.
 *
 * The agent is told what has already been tried on this customer so it can
 * reason about escalation ("WhatsApp twice already, no conversion —
 * escalate") rather than proposing the same nudge forever. Without this the
 * decision engine sees an empty history on every event and cannot tell a
 * first attempt from a fourth.
 */
export async function getCustomerRetryHistory(
  customerId: string
): Promise<RetryAttempt[]> {
  try {
    return await getDb().getCustomerRetryHistory(customerId, 20);
  } catch (err: any) {
    // History is advisory, not a gate — the hard limits live in guardrails.ts
    // and are enforced there. Losing it degrades reasoning, not safety.
    console.error("[retry-history] lookup failed:", err?.message ?? err);
    return [];
  }
}

/**
 * Which attempt number the action about to be executed represents, for THIS
 * event. Previously hardcoded to 1, which made every row in recovery_actions
 * claim to be a first attempt.
 */
export async function getNextAttemptNumber(revenueEventId: string): Promise<number> {
  try {
    return (await getDb().countActionsForEvent(revenueEventId)) + 1;
  } catch (err: any) {
    console.error("[retry-history] attempt count failed:", err?.message ?? err);
    return 1;
  }
}
