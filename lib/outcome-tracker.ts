import { getDb } from "./db";
import { logAudit } from "./audit";

/**
 * How long after a failure a successful payment on the same order still
 * counts as this pipeline's recovery: 24 hours.
 *
 * Named and exported rather than left as a local. The line it replaces called
 * it "configurable", which it never was, and a reader trusting that comment
 * would have gone looking for a setting that does not exist. Exported so the
 * tests pin the boundary against the same number the code uses, not a copy
 * of it. Changing it changes what the dashboard's recovered total means,
 * which is why it is a code change and not a knob.
 */
export const ATTRIBUTION_WINDOW_MINUTES = 60 * 24;

/**
 * Called from the webhook when a previously-failed order is paid.
 * Without this, "amount recovered" is an assertion, not a measurement —
 * this is what makes the number defensible.
 */
export async function attributeRecovery(params: {
  razorpayOrderId: string;
  recoveredPaymentId: string;
  recoveredAmountPaise: number;
  /**
   * When the successful payment happened. Defaults to now, which is right
   * when the recovery has just occurred and wrong whenever it has not — see
   * the window check below.
   */
  recoveredAtIso?: string;
}) {
  const db = getDb();

  const event = await db.findLatestFailedEventByOrderId(params.razorpayOrderId);

  if (!event) return; // no matching failure on record — not this pipeline's recovery

  /**
   * The attribution window spans failure to recovery, not failure to now.
   *
   * Measuring against the clock silently made attribution depend on when the
   * question was asked: a recovery that happened twenty minutes after its
   * failure would be credited if processed immediately and discarded if the
   * event was two days old, even though the two timestamps involved had not
   * changed. On a batch spread across a week that dropped three quarters of
   * the recoveries and drove measured lift negative — the treated arm lost
   * its conversions while the control arm kept the few that happened to be
   * recent.
   *
   * It also made "average time to recovery" measure the age of the batch
   * rather than the speed of the agent.
   */
  const windowMinutes = ATTRIBUTION_WINDOW_MINUTES;
  const recoveredAt = params.recoveredAtIso
    ? new Date(params.recoveredAtIso)
    : new Date();

  const elapsedMs = recoveredAt.getTime() - new Date(event.received_at).getTime();

  // A recovery cannot precede the failure it recovers. A negative gap means
  // the two records disagree about the order of events, which is a reason to
  // refuse the attribution rather than to record a negative duration.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  if (elapsedMs >= windowMinutes * 60 * 1000) return;

  const result = await db.insertOutcome({
    revenue_event_id: event.id,
    recovered: true,
    recovered_amount_paise: params.recoveredAmountPaise,
    recovered_payment_id: params.recoveredPaymentId,
    attribution_window_minutes: windowMinutes,
    resolved_at: recoveredAt.toISOString(),
  });

  // A duplicate delivery of the same success event is already attributed.
  // The data layer normalises Postgres 23505 and MySQL 1062 to this shape.
  if ("duplicate" in result) return;

  await logAudit(event.id, "outcome_recorded", {
    recovered: true,
    recovered_amount_paise: params.recoveredAmountPaise,
    recovered_payment_id: params.recoveredPaymentId,
  });
}
