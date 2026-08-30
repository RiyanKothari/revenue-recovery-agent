import { supabase } from "./supabase";

export type AuditStage =
  | "event_received"
  | "classified"
  | "agent_decided"
  | "action_executed"
  | "stopping_rule_triggered"
  | "outcome_recorded";

/**
 * Every stage of the pipeline calls this. It's deliberately dumb — an
 * append-only insert, no updates, no deletes. The dashboard's live feed and
 * the batch summary both read straight from this table. If it isn't logged
 * here, it didn't happen as far as the submission's "audit trail"
 * requirement is concerned.
 */
export async function logAudit(
  revenueEventId: string,
  stage: AuditStage,
  detail: Record<string, unknown>
) {
  const { error } = await supabase.from("audit_log").insert({
    revenue_event_id: revenueEventId,
    stage,
    detail,
  });

  if (error) {
    // Audit logging failing silently would defeat the point — surface it
    // loudly rather than swallowing it.
    console.error(`[audit] failed to log stage="${stage}":`, error.message);
  }
}
