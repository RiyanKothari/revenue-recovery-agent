import { NextRequest, NextResponse } from "next/server";
import { verifyRazorpaySignature } from "@/lib/verify-webhook";
import { supabase } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";
import { classify } from "@/lib/classifier";
import { checkGuardrails } from "@/lib/guardrails";
import { decide } from "@/lib/decision-engine";
import { executeAction } from "@/lib/action-executor";
import { attributeRecovery } from "@/lib/outcome-tracker";
import { getCustomerRetryHistory, getNextAttemptNumber } from "@/lib/retry-history";
import { DEFAULT_POLICY } from "@/lib/policy";
import { assignArm } from "@/lib/experiment";
import { estimateRecoveryProbability } from "@/lib/propensity";
import { getObservedStats } from "@/lib/propensity-store";
import { evaluateExpectedValue } from "@/lib/expected-value";

/**
 * The one entry point for every "revenue at risk" signal in this project.
 * Order of operations is deliberate and mirrors the submission's own bar:
 *   1. verify + dedupe (idempotency — the bug we already found once)
 *   2. classify (deterministic)
 *   3. guardrails (deterministic, can veto everything downstream)
 *   4. expected value (deterministic — is acting worth it, not just allowed)
 *   5. experiment arm (a holdout slice is left untreated, on purpose)
 *   6. agent decides (LLM, but only within what everything above allowed)
 *   7. execute + log (every step hits audit_log)
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;

  if (!verifyRazorpaySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const payload = JSON.parse(rawBody);
  const eventType = payload.event as string;
  const paymentEntity = payload.payload?.payment?.entity;

  // A successful payment on an order we previously saw fail is what turns
  // "amount recovered" from an assertion into a measurement.
  if (eventType === "order.paid" || eventType === "payment.captured") {
    if (paymentEntity?.order_id) {
      await attributeRecovery({
        razorpayOrderId: paymentEntity.order_id,
        recoveredPaymentId: paymentEntity.id,
        recoveredAmountPaise: paymentEntity.amount,
      });
    }
    return NextResponse.json({ status: "outcome_recorded" });
  }

  // Only payment.failed drives the recovery loop for now; other event
  // types are stored for the audit trail / future signal types (see
  // blueprint stretch goal: checkout abandonment, mandate retry).
  if (eventType !== "payment.failed") {
    return NextResponse.json({ status: "ignored", event: eventType });
  }

  // Razorpay sends the event id in a header, not the body — this is the
  // documented idempotency key for webhook retries.
  const razorpayEventId = req.headers.get("x-razorpay-event-id") ?? paymentEntity?.id;

  if (!razorpayEventId || !paymentEntity) {
    return NextResponse.json({ error: "malformed_payload" }, { status: 400 });
  }

  // --- 1. Idempotent insert: this is the exact bug class NicheFlow's
  // webhook handler had. Unique constraint on razorpay_event_id does the
  // real enforcement; the .maybeSingle() check is just to short-circuit
  // cleanly and return 200 instead of erroring on a legitimate retry.
  const { data: existing } = await supabase
    .from("revenue_events")
    .select("id")
    .eq("razorpay_event_id", razorpayEventId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ status: "duplicate_ignored" });
  }

  const { data: event, error: insertError } = await supabase
    .from("revenue_events")
    .insert({
      razorpay_event_id: razorpayEventId,
      event_type: eventType,
      razorpay_payment_id: paymentEntity.id,
      razorpay_order_id: paymentEntity.order_id,
      amount_paise: paymentEntity.amount,
      currency: paymentEntity.currency ?? "INR",
      error_code: paymentEntity.error_code,
      error_description: paymentEntity.error_description,
      payment_method: paymentEntity.method,
      customer_id: paymentEntity.customer_id ?? paymentEntity.contact,
      customer_contact: paymentEntity.contact,
      raw_payload: payload,
    })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await logAudit(event.id, "event_received", {
    razorpay_event_id: razorpayEventId,
    amount_paise: paymentEntity.amount,
  });

  // --- 2. Classify (deterministic)
  const classification = classify({
    error_code: paymentEntity.error_code,
    error_description: paymentEntity.error_description,
    payment_method: paymentEntity.method,
  });

  await supabase
    .from("revenue_events")
    .update({ root_cause: classification.root_cause, processed_at: new Date().toISOString() })
    .eq("id", event.id);

  await logAudit(event.id, "classified", { classification });

  if (!classification.is_recoverable) {
    await logAudit(event.id, "stopping_rule_triggered", {
      reason: "not_recoverable_or_unknown_cause",
    });
    return NextResponse.json({ status: "not_recoverable" });
  }

  // --- 3. Guardrails (deterministic veto, checked BEFORE the agent runs)
  const customerId = paymentEntity.customer_id ?? paymentEntity.contact;
  const guardrailResult = await checkGuardrails(customerId, event.id);

  if (!guardrailResult.allowed) {
    await logAudit(event.id, "stopping_rule_triggered", {
      reason: guardrailResult.reason,
    });
    return NextResponse.json({ status: "blocked_by_guardrail", reason: guardrailResult.reason });
  }

  // --- 4. Economic gate (deterministic, runs BEFORE the model).
  // Guardrails decided we're allowed to act; this decides whether acting is
  // worth it. Running it here means an economically irrational action is
  // never in the model's reach.
  const policy = DEFAULT_POLICY;
  const observed = await getObservedStats(classification.root_cause);
  const probability = estimateRecoveryProbability(classification.root_cause, observed);
  const ev = evaluateExpectedValue({
    amountPaise: paymentEntity.amount,
    probability,
    policy,
  });

  if (!ev.proceed) {
    await logAudit(event.id, "stopping_rule_triggered", {
      reason: "negative_expected_value",
      detail: ev.reason,
      expected_value_paise: ev.expectedValuePaise,
      recovery_probability: probability,
      policy_version: policy.version,
    });
    return NextResponse.json({ status: "skipped_negative_ev" });
  }

  // --- 5. Experiment assignment.
  // Assigned only among events that were both ALLOWED and WORTH acting on,
  // so the control arm is a true counterfactual: events we would otherwise
  // have intervened on. Assigning earlier would dilute the measurement with
  // events that were never going to be touched.
  const arm = assignArm(event.id, policy);

  const { error: assignmentError } = await supabase
    .from("experiment_assignments")
    .insert({
      revenue_event_id: event.id,
      arm,
      policy_version: policy.version,
      recovery_probability: probability,
      expected_value_paise: ev.expectedValuePaise,
    });

  // Assignment is a pure function of the event id, so a failed write costs
  // reproducibility, not correctness — but an unrecorded control event would
  // silently vanish from the denominator and inflate measured lift.
  if (assignmentError && assignmentError.code !== "23505") {
    await logAudit(event.id, "stopping_rule_triggered", {
      reason: "experiment_assignment_failed",
      detail: assignmentError.message,
    });
    return NextResponse.json({ error: "assignment_failed" }, { status: 500 });
  }

  if (arm === "control") {
    await logAudit(event.id, "stopping_rule_triggered", {
      reason: "holdout_control",
      detail:
        "Deliberately untreated to measure the do-nothing baseline. No intervention taken.",
      policy_version: policy.version,
    });
    return NextResponse.json({ status: "holdout_control" });
  }

  // --- 6. Agent decides (LLM, scoped to pre-approved actions only)
  const decision = await decide({
    revenueEventId: event.id,
    classification,
    amountPaise: paymentEntity.amount,
    customerRetryHistory: await getCustomerRetryHistory(customerId),
  });

  // --- 7. Execute + log
  await executeAction({
    revenueEventId: event.id,
    agentDecisionId: decision.decisionId,
    decision,
    amountPaise: paymentEntity.amount,
    currency: paymentEntity.currency ?? "INR",
    customerContact: paymentEntity.contact,
    attemptNumber: await getNextAttemptNumber(event.id),
  });

  return NextResponse.json({ status: "processed", action: decision.action });
}
