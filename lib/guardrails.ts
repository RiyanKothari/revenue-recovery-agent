import { supabase } from "./supabase";

/**
 * Guardrails run BEFORE the agent is even asked to decide anything, and
 * their result is a hard veto — the agent's tool-calling is scoped so it
 * physically cannot take an action a guardrail has blocked. This is what
 * "bounded" and "compliant escalation" mean in the submission bar: not a
 * prompt asking the LLM to behave, but code that doesn't let it do
 * otherwise.
 */

const MAX_RETRY_ATTEMPTS = 3;
const COOLDOWN_MINUTES = 240; // 4 hours between nudges to the same customer

export interface GuardrailResult {
  allowed: boolean;
  reason?: string; // populated when allowed = false, logged to audit trail
}

export async function checkGuardrails(
  customerId: string,
  revenueEventId: string
): Promise<GuardrailResult> {
  // 1. Consent / DND — checked first, no exceptions.
  const { data: consent } = await supabase
    .from("customer_consent")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();

  if (consent?.dnd) {
    return { allowed: false, reason: "customer_dnd_opt_out" };
  }

  // 2. Max retry attempts for this specific event.
  const { count: attemptCount } = await supabase
    .from("recovery_actions")
    .select("id, agent_decisions!inner(revenue_event_id)", {
      count: "exact",
      head: true,
    })
    .eq("agent_decisions.revenue_event_id", revenueEventId);

  if ((attemptCount ?? 0) >= MAX_RETRY_ATTEMPTS) {
    return { allowed: false, reason: "max_retry_attempts_reached" };
  }

  // 3. Cooldown window since the last nudge to this customer, across events.
  const cooldownCutoff = new Date(
    Date.now() - COOLDOWN_MINUTES * 60 * 1000
  ).toISOString();

  const { data: recentActions } = await supabase
    .from("recovery_actions")
    .select("executed_at, agent_decisions!inner(revenue_event_id, revenue_events!inner(customer_id))")
    .eq("agent_decisions.revenue_events.customer_id", customerId)
    .gte("executed_at", cooldownCutoff)
    .limit(1);

  if (recentActions && recentActions.length > 0) {
    return { allowed: false, reason: "cooldown_window_active" };
  }

  // 4. Refund/dispute kill-switch — if this event's payment was later
  // refunded or disputed, never nudge for it again.
  const { data: event } = await supabase
    .from("revenue_events")
    .select("razorpay_payment_id")
    .eq("id", revenueEventId)
    .single();

  if (event?.razorpay_payment_id) {
    const { data: disputeFlag } = await supabase
      .from("audit_log")
      .select("id")
      .eq("revenue_event_id", revenueEventId)
      .eq("stage", "stopping_rule_triggered")
      .contains("detail", { reason: "refund_or_dispute" })
      .maybeSingle();

    if (disputeFlag) {
      return { allowed: false, reason: "refund_or_dispute_flagged" };
    }
  }

  return { allowed: true };
}

export { MAX_RETRY_ATTEMPTS, COOLDOWN_MINUTES };
