import { supabase } from "./supabase";

/**
 * Guardrails run BEFORE the agent is even asked to decide anything, and
 * their result is a hard veto — the agent's tool-calling is scoped so it
 * physically cannot take an action a guardrail has blocked. This is what
 * "bounded" and "compliant escalation" mean in the submission bar: not a
 * prompt asking the LLM to behave, but code that doesn't let it do
 * otherwise.
 *
 * Every check below fails CLOSED. An earlier version destructured only
 * `{ data }` and dropped `error`, which meant a Supabase outage made every
 * guardrail evaluate to "allowed" — a DND opt-out would have been nudged
 * anyway. If we cannot prove an action is safe, we do not take it.
 */

const MAX_RETRY_ATTEMPTS = 3;
const COOLDOWN_MINUTES = 240; // 4 hours between nudges to the same customer

export interface GuardrailResult {
  allowed: boolean;
  reason?: string; // populated when allowed = false, logged to audit trail
}

/**
 * Minimal shape of the Supabase client this module actually uses. Injectable
 * so the safety rules can be tested without a live database — these are the
 * rules that keep the agent from messaging people who asked not to be
 * messaged, so they deserve tests more than anything else here.
 */
export type GuardrailDb = Pick<typeof supabase, "from">;

export async function checkGuardrails(
  customerId: string,
  revenueEventId: string,
  db: GuardrailDb = supabase
): Promise<GuardrailResult> {
  // 1. Consent / DND — checked first, no exceptions.
  const { data: consent, error: consentError } = await db
    .from("customer_consent")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();

  if (consentError) {
    return { allowed: false, reason: "guardrail_check_failed:consent" };
  }

  if (consent?.dnd) {
    return { allowed: false, reason: "customer_dnd_opt_out" };
  }

  // 2. Max retry attempts for this specific event.
  const { count: attemptCount, error: attemptError } = await db
    .from("recovery_actions")
    .select("id, agent_decisions!inner(revenue_event_id)", {
      count: "exact",
      head: true,
    })
    .eq("agent_decisions.revenue_event_id", revenueEventId);

  if (attemptError) {
    return { allowed: false, reason: "guardrail_check_failed:attempt_count" };
  }

  // A null count with no error means the query ran but returned nothing
  // countable — treat that as unproven rather than zero.
  if (attemptCount == null || attemptCount >= MAX_RETRY_ATTEMPTS) {
    return {
      allowed: false,
      reason:
        attemptCount == null
          ? "guardrail_check_failed:attempt_count_unavailable"
          : "max_retry_attempts_reached",
    };
  }

  // 3. Cooldown window since the last nudge to this customer, across events.
  const cooldownCutoff = new Date(
    Date.now() - COOLDOWN_MINUTES * 60 * 1000
  ).toISOString();

  const { data: recentActions, error: cooldownError } = await db
    .from("recovery_actions")
    .select(
      "executed_at, agent_decisions!inner(revenue_event_id, revenue_events!inner(customer_id))"
    )
    .eq("agent_decisions.revenue_events.customer_id", customerId)
    .gte("executed_at", cooldownCutoff)
    .limit(1);

  if (cooldownError) {
    return { allowed: false, reason: "guardrail_check_failed:cooldown" };
  }

  if (recentActions && recentActions.length > 0) {
    return { allowed: false, reason: "cooldown_window_active" };
  }

  // 4. Refund/dispute kill-switch — if this event's payment was later
  // refunded or disputed, never nudge for it again.
  const { data: event, error: eventError } = await db
    .from("revenue_events")
    .select("razorpay_payment_id")
    .eq("id", revenueEventId)
    .single();

  // The webhook inserts this row before calling us, so a missing or
  // unreadable event means our view of the world is wrong. Refuse.
  if (eventError || !event) {
    return { allowed: false, reason: "guardrail_check_failed:event_lookup" };
  }

  if (event.razorpay_payment_id) {
    const { data: disputeFlag, error: disputeError } = await db
      .from("audit_log")
      .select("id")
      .eq("revenue_event_id", revenueEventId)
      .eq("stage", "stopping_rule_triggered")
      .contains("detail", { reason: "refund_or_dispute" })
      .maybeSingle();

    // maybeSingle() errors if more than one dispute flag exists. Both an
    // error and a hit mean "do not nudge", so they collapse to one branch.
    if (disputeError || disputeFlag) {
      return { allowed: false, reason: "refund_or_dispute_flagged" };
    }
  }

  return { allowed: true };
}

export { MAX_RETRY_ATTEMPTS, COOLDOWN_MINUTES };
