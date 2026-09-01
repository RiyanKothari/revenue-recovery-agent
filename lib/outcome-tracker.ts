import { getDb } from "./db";
import { logAudit } from "./audit";

/**
 * Called from the webhook when a previously-failed order is paid.
 * Without this, "amount recovered" is an assertion, not a measurement —
 * this is what makes the number defensible.
 */
export async function attributeRecovery(params: {
  razorpayOrderId: string;
  recoveredPaymentId: string;
  recoveredAmountPaise: number;
}) {
  const db = getDb();

  const event = await db.findLatestFailedEventByOrderId(params.razorpayOrderId);

  if (!event) return; // no matching failure on record — not this pipeline's recovery

  const windowMinutes = 60 * 24; // 24h attribution window, configurable
  const withinWindow =
    Date.now() - new Date(event.received_at).getTime() < windowMinutes * 60 * 1000;

  if (!withinWindow) return;

  const result = await db.insertOutcome({
    revenue_event_id: event.id,
    recovered: true,
    recovered_amount_paise: params.recoveredAmountPaise,
    recovered_payment_id: params.recoveredPaymentId,
    attribution_window_minutes: windowMinutes,
    resolved_at: new Date().toISOString(),
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
