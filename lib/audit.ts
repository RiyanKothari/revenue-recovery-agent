import { getDb } from "./db";

export type AuditStage =
  | "event_received"
  | "classified"
  | "agent_decided"
  | "action_executed"
  | "stopping_rule_triggered"
  | "outcome_recorded"
  // A send that was decided but deliberately deferred — see lib/send-window.ts.
  // Distinct from action_executed because nothing has been sent yet, and a
  // trace that showed the two identically would claim a message reached
  // someone hours before it did.
  | "action_scheduled"
  // What the provider said about a message AFTER we sent it. Appended rather
  // than overwriting the send row, so a message that went accepted, then sent,
  // then failed leaves all three in the trail.
  | "delivery_status_updated";

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
  try {
    await getDb().insertAudit(revenueEventId, stage, detail);
  } catch (err: any) {
    // Audit logging failing silently would defeat the point — surface it
    // loudly rather than swallowing it.
    console.error(`[audit] failed to log stage="${stage}":`, err?.message ?? err);
  }
}
