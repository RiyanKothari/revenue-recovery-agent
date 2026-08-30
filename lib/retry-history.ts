import { supabase } from "./supabase";

/**
 * Prior recovery attempts, read back out of recovery_actions.
 *
 * The agent is told what has already been tried on this customer so it can
 * reason about escalation ("WhatsApp twice already, no conversion — escalate")
 * rather than proposing the same nudge forever. Without this the decision
 * engine sees an empty history on every event and cannot tell a first
 * attempt from a fourth.
 */

export interface RetryAttempt {
  attempt_number: number;
  channel: string;
  status: string;
}

/**
 * Every attempt made for this customer, across all of their failed payments.
 * Ordered oldest-first so the agent reads it as a timeline.
 */
export async function getCustomerRetryHistory(
  customerId: string
): Promise<RetryAttempt[]> {
  const { data, error } = await supabase
    .from("recovery_actions")
    .select(
      "attempt_number, channel, status, executed_at, agent_decisions!inner(revenue_events!inner(customer_id))"
    )
    .eq("agent_decisions.revenue_events.customer_id", customerId)
    .order("executed_at", { ascending: true })
    .limit(20);

  if (error) {
    // History is advisory, not a gate — the hard limits live in guardrails.ts
    // and are enforced there. Losing it degrades reasoning, not safety.
    console.error("[retry-history] lookup failed:", error.message);
    return [];
  }

  return (data ?? []).map((row: any) => ({
    attempt_number: row.attempt_number,
    channel: row.channel,
    status: row.status,
  }));
}

/**
 * Which attempt number the action about to be executed represents, for THIS
 * event. Previously hardcoded to 1, which made every row in recovery_actions
 * claim to be a first attempt.
 */
export async function getNextAttemptNumber(
  revenueEventId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("recovery_actions")
    .select("id, agent_decisions!inner(revenue_event_id)", {
      count: "exact",
      head: true,
    })
    .eq("agent_decisions.revenue_event_id", revenueEventId);

  if (error) {
    console.error("[retry-history] attempt count failed:", error.message);
    return 1;
  }

  return (count ?? 0) + 1;
}
