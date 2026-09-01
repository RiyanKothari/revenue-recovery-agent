import { NextRequest, NextResponse } from "next/server";
import { verifyRazorpaySignature } from "@/lib/verify-webhook";
import { getDb } from "@/lib/db";
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
/**
 * Events that permanently disqualify an event from further recovery. Both
 * refund shapes are included because Razorpay emits `refund.created` on
 * initiation and `refund.processed` on settlement, and a merchant may have
 * subscribed to either.
 */
const REFUND_OR_DISPUTE_EVENTS = new Set([
  "refund.created",
  "refund.processed",
  "payment.dispute.created",
  "payment.dispute.lost",
]);

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

  /**
   * Refunds and disputes arm the kill-switch.
   *
   * guardrails.ts refuses to act on an event once a `refund_or_dispute`
   * stopping rule has been recorded against it — but until this branch
   * existed, nothing anywhere wrote that entry. The rule read a flag no code
   * ever set, so the fourth guardrail was unreachable: a customer whose
   * payment had been refunded could still be chased for it.
   *
   * Recording it here rather than polling Razorpay keeps the check off the
   * webhook's critical path and consistent with how every other signal in
   * this pipeline arrives.
   */
  if (REFUND_OR_DISPUTE_EVENTS.has(eventType)) {
    const refundedPaymentId =
      payload.payload?.refund?.entity?.payment_id ??
      payload.payload?.dispute?.entity?.payment_id ??
      paymentEntity?.id;

    if (!refundedPaymentId) {
      return NextResponse.json({ status: "ignored", event: eventType });
    }

    const eventId = await getDb().findEventIdByPaymentId(refundedPaymentId);

    // A refund on a payment we never saw fail isn't ours to record.
    if (!eventId) {
      return NextResponse.json({ status: "no_matching_event" });
    }

    await logAudit(eventId, "stopping_rule_triggered", {
      reason: "refund_or_dispute",
      event: eventType,
      razorpay_payment_id: refundedPaymentId,
      detail: "Payment refunded or disputed — no further recovery attempts.",
    });

    return NextResponse.json({ status: "refund_or_dispute_recorded" });
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
  const db = getDb();
  const existingId = await db.findEventIdByRazorpayEventId(razorpayEventId);

  if (existingId) {
    // Treating every known event id as a finished duplicate loses events. If
    // the first attempt inserted the row and then died mid-pipeline — an
    // Anthropic timeout, a transient database error — the event is stuck:
    // Razorpay's retry short-circuits here forever and it is never decided,
    // never actioned, and never appears as an exception. It just vanishes.
    //
    // An agent_decisions row is the safe marker for "already handled":
    // decide() writes it before any send happens, so if one exists a re-run
    // could double-contact the customer, and if it doesn't, resuming is safe.
    let decided: number;
    try {
      decided = await db.countDecisionsForEvent(existingId);
    } catch {
      // Can't tell whether it was handled — refuse rather than risk a second
      // send. Razorpay will retry.
      return NextResponse.json({ error: "dedupe_check_failed" }, { status: 500 });
    }

    if (decided > 0) {
      return NextResponse.json({ status: "duplicate_ignored" });
    }

    /**
     * Resume against the payload that CREATED the row, not the one that just
     * arrived.
     *
     * Both carry the same event id, but nothing guarantees they carry the
     * same content — a replayed batch can reuse an event id with a different
     * body. Processing the stored row's id against a fresh payload evaluates
     * the guardrails on one customer and records the action against another.
     *
     * That is not hypothetical: a synthetic batch replayed `evt_synthetic_1150`
     * with a different customer, the consent check passed for the new one, and
     * the resulting WhatsApp message was recorded against the original — a
     * customer with DND set. The conformance verifier caught it as an I1
     * violation. The stored row is the authority for what an event is.
     */
    const storedPayload = await db.getStoredPayload(existingId);
    const storedEntity = storedPayload?.payload?.payment?.entity;

    if (!storedEntity) {
      await logAudit(existingId, "stopping_rule_triggered", {
        reason: "stored_payload_unreadable",
        detail: "Cannot resume without the payload that created this event.",
      });
      return NextResponse.json({ error: "stored_payload_unreadable" }, { status: 500 });
    }

    await logAudit(existingId, "event_received", {
      razorpay_event_id: razorpayEventId,
      note: "Resuming an event whose first attempt did not reach a decision.",
    });

    return guarded(existingId, () =>
      processEvent({ eventId: existingId, paymentEntity: storedEntity })
    );
  }

  let inserted;
  try {
    inserted = await db.insertRevenueEvent({
      razorpay_event_id: razorpayEventId,
      event_type: eventType,
      razorpay_payment_id: paymentEntity.id ?? null,
      razorpay_order_id: paymentEntity.order_id ?? null,
      amount_paise: paymentEntity.amount,
      currency: paymentEntity.currency ?? "INR",
      error_code: paymentEntity.error_code ?? null,
      error_description: paymentEntity.error_description ?? null,
      payment_method: paymentEntity.method ?? null,
      customer_id: paymentEntity.customer_id ?? paymentEntity.contact ?? null,
      customer_contact: paymentEntity.contact ?? null,
      raw_payload: payload,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "insert_failed" }, { status: 500 });
  }

  // Two concurrent deliveries can both pass the check above; the unique
  // constraint is the real enforcement, and losing that race just means the
  // other request is handling it.
  if ("duplicate" in inserted) {
    return NextResponse.json({ status: "duplicate_ignored" });
  }

  await logAudit(inserted.id, "event_received", {
    razorpay_event_id: razorpayEventId,
    amount_paise: paymentEntity.amount,
  });

  return guarded(inserted.id, () => processEvent({ eventId: inserted.id, paymentEntity }));
}

/**
 * Turns an unhandled failure into a JSON 500 rather than an empty body.
 *
 * Next returns no body for an uncaught throw, which gave clients nothing to
 * parse — that is what killed the first batch run. Callers get a reason they
 * can log, and the event stays resumable: no decision was recorded, so a
 * redelivery picks it up where it stopped.
 */
async function guarded(
  eventId: string,
  run: () => Promise<Response>
): Promise<Response> {
  try {
    return await run();
  } catch (err: any) {
    const detail = String(err?.message ?? err);
    await logAudit(eventId, "stopping_rule_triggered", {
      reason: "pipeline_error",
      detail: detail.slice(0, 300),
    });
    return NextResponse.json(
      { error: "pipeline_error", detail: detail.slice(0, 300) },
      { status: 500 }
    );
  }
}

/**
 * Everything after the event exists in the database. Split out so a resumed
 * event — one whose first delivery died before reaching a decision — runs the
 * identical path rather than a second, subtly different one.
 */
async function processEvent({
  eventId,
  paymentEntity,
}: {
  eventId: string;
  paymentEntity: any;
}) {
  // --- 2. Classify (deterministic)
  const classification = classify({
    error_code: paymentEntity.error_code,
    error_description: paymentEntity.error_description,
    payment_method: paymentEntity.method,
  });

  await getDb().setClassification(
    eventId,
    classification.root_cause,
    new Date().toISOString()
  );

  await logAudit(eventId, "classified", { classification });

  if (!classification.is_recoverable) {
    await logAudit(eventId, "stopping_rule_triggered", {
      reason: "not_recoverable_or_unknown_cause",
    });
    return NextResponse.json({ status: "not_recoverable" });
  }

  // --- 3. Guardrails (deterministic veto, checked BEFORE the agent runs)
  const customerId = paymentEntity.customer_id ?? paymentEntity.contact;

  // Without an identifier there is nothing to look consent up against. The
  // DND query would match no rows, `consent?.dnd` would be falsy, and the
  // event would sail through as if the customer had opted in — a fail-open
  // hole in the one rule that has no exceptions. The conformance verifier
  // can't check these events either, since it keys on customer_id.
  if (!customerId) {
    await logAudit(eventId, "stopping_rule_triggered", {
      reason: "no_customer_identifier",
      detail: "Payload carried neither customer_id nor contact — consent cannot be verified.",
    });
    return NextResponse.json({
      status: "blocked_by_guardrail",
      reason: "no_customer_identifier",
    });
  }

  const guardrailResult = await checkGuardrails(customerId, eventId);

  if (!guardrailResult.allowed) {
    await logAudit(eventId, "stopping_rule_triggered", {
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
    await logAudit(eventId, "stopping_rule_triggered", {
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
  const arm = assignArm(eventId, policy);

  // Assignment is a pure function of the event id, so a failed write costs
  // reproducibility, not correctness — but an unrecorded control event would
  // silently vanish from the denominator and inflate measured lift.
  try {
    await getDb().insertAssignment({
      revenue_event_id: eventId,
      arm,
      policy_version: policy.version,
      recovery_probability: probability,
      expected_value_paise: ev.expectedValuePaise,
    });
  } catch (err: any) {
    await logAudit(eventId, "stopping_rule_triggered", {
      reason: "experiment_assignment_failed",
      detail: err?.message ?? String(err),
    });
    return NextResponse.json({ error: "assignment_failed" }, { status: 500 });
  }

  if (arm === "control") {
    await logAudit(eventId, "stopping_rule_triggered", {
      reason: "holdout_control",
      detail:
        "Deliberately untreated to measure the do-nothing baseline. No intervention taken.",
      policy_version: policy.version,
    });
    return NextResponse.json({ status: "holdout_control" });
  }

  // --- 6. Agent decides (LLM, scoped to pre-approved actions only)
  const decision = await decide({
    revenueEventId: eventId,
    classification,
    amountPaise: paymentEntity.amount,
    customerRetryHistory: await getCustomerRetryHistory(customerId),
  });

  // --- 7. Execute + log
  await executeAction({
    revenueEventId: eventId,
    agentDecisionId: decision.decisionId,
    decision,
    amountPaise: paymentEntity.amount,
    currency: paymentEntity.currency ?? "INR",
    customerContact: paymentEntity.contact,
    attemptNumber: await getNextAttemptNumber(eventId),
  });

  return NextResponse.json({ status: "processed", action: decision.action });
}
