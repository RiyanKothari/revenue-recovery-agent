import { supabase } from "./supabase";
import { logAudit } from "./audit";

/**
 * Call this from a separate webhook handler listening for `order.paid` /
 * `payment.authorized` (or on a poll loop against fetchPaymentStatus).
 * Without this, "amount recovered" is an assertion, not a measurement —
 * this is what makes the number defensible.
 */
export async function attributeRecovery(params: {
  razorpayOrderId: string;
  recoveredPaymentId: string;
  recoveredAmountPaise: number;
}) {
  const { data: event } = await supabase
    .from("revenue_events")
    .select("id, received_at")
    .eq("razorpay_order_id", params.razorpayOrderId)
    .eq("event_type", "payment.failed")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!event) return; // no matching failure on record — not this pipeline's recovery

  const windowMinutes = 60 * 24; // 24h attribution window, configurable
  const withinWindow =
    Date.now() - new Date(event.received_at).getTime() < windowMinutes * 60 * 1000;

  if (!withinWindow) return;

  const { error } = await supabase.from("outcomes").insert({
    revenue_event_id: event.id,
    recovered: true,
    recovered_amount_paise: params.recoveredAmountPaise,
    recovered_payment_id: params.recoveredPaymentId,
    attribution_window_minutes: windowMinutes,
    resolved_at: new Date().toISOString(),
  });

  // 23505 = duplicate delivery of the same success event; already attributed.
  if (error) {
    if (error.code === "23505") return;
    throw error;
  }

  await logAudit(event.id, "outcome_recorded", {
    recovered: true,
    recovered_amount_paise: params.recoveredAmountPaise,
    recovered_payment_id: params.recoveredPaymentId,
  });
}
