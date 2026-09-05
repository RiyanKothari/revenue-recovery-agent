import { getDb, type RecoveryDb } from "./db";
import { logAudit } from "./audit";
import { createAndSendRetryLink } from "./razorpay-mcp-client";
import { sendWhatsAppRetryNudge } from "./whatsapp";
import type { Decision } from "./decision-engine";
import {
  claimLinkBudget,
  isLinkQuotaError,
  isRateLimitError,
  seedLinkBudget,
} from "./link-budget";
import { resolveSendWindow } from "./send-window";

/**
 * Turns an agent decision into a real action. This is where "detects
 * revenue at risk AND executes a bounded recovery workflow" stops being a
 * claim and becomes something you can point at in the audit log.
 *
 * Writes to recovery_actions are checked, not fire-and-forget. guardrails.ts
 * counts rows in that table to enforce the retry ceiling and the cooldown
 * window, so a silently dropped insert would leave those counters blind and
 * let the same customer be nudged indefinitely — the write path quietly
 * disabling the read path's safety rules.
 */

export type ExecutorDb = Pick<RecoveryDb, "insertRecoveryAction" | "countLiveLinks">;

export interface ExecutorDeps {
  db: ExecutorDb;
  createLink: typeof createAndSendRetryLink;
  sendWhatsApp: typeof sendWhatsAppRetryNudge;
  audit: typeof logAudit;
  /**
   * Injected, not called directly, because it reads the wall clock.
   *
   * The first version called `resolveSendWindow` inline. Every test that
   * asserts a send happened then passed during the day and failed after 21:00
   * IST, when quiet hours correctly deferred the send instead. The suite was
   * green when I wrote it and red six hours later, which is the same defect
   * as the batch generator stamping events from `Date.now()`: a test that
   * reads the clock is a test whose result depends on when you run it.
   */
  resolveWindow: typeof resolveSendWindow;
}

/** Resolved per call, not at module scope: getDb() throws without a
 *  configured DATABASE_URL, and importing this module must never do that. */
function resolveDeps(overrides: Partial<ExecutorDeps>): ExecutorDeps {
  return {
    db: overrides.db ?? getDb(),
    createLink: overrides.createLink ?? createAndSendRetryLink,
    sendWhatsApp: overrides.sendWhatsApp ?? sendWhatsAppRetryNudge,
    audit: overrides.audit ?? logAudit,
    resolveWindow: overrides.resolveWindow ?? resolveSendWindow,
  };
}

export async function executeAction(
  params: {
    revenueEventId: string;
    agentDecisionId: string;
    decision: Decision;
    amountPaise: number;
    currency: string;
    customerContact: string;
    attemptNumber: number;
    /**
     * The event's own time, stamped onto the recorded action so the send sits
     * on the same timeline as the failure it answers. Omitted in production,
     * where they are the same moment.
     */
    eventTimeIso?: string;
    /**
     * Why the payment failed. Used only to choose a send *time* — the channel
     * was already chosen by the agent, and nothing here revisits that.
     */
    rootCause?: string;
  },
  deps: Partial<ExecutorDeps> = {}
) {
  const { db, createLink, sendWhatsApp, audit, resolveWindow } = resolveDeps(deps);
  const { decision, revenueEventId, agentDecisionId, eventTimeIso } = params;

  /**
   * An action that happened but wasn't recorded is worse than one that never
   * happened: the customer was contacted, but no guardrail can see it. Throw
   * rather than continue. The webhook's idempotency check means Razorpay's
   * retry short-circuits on the existing revenue_event, so throwing here
   * cannot cause a second send.
   */
  const recordAction = async (
    row: Parameters<ExecutorDb["insertRecoveryAction"]>[0],
    channel: string
  ) => {
    try {
      // Stamped here rather than at each call site: every recorded action
      // goes through this funnel, so the timeline cannot drift between them.
      await db.insertRecoveryAction({ ...row, executed_at: eventTimeIso ?? row.executed_at });
    } catch (err: any) {
      await audit(revenueEventId, "action_executed", {
        channel,
        delivery_success: false,
        error: `action_not_recorded: ${err?.message ?? err}`,
        warning:
          "Action may have been delivered but is absent from recovery_actions — retry ceiling and cooldown cannot count it.",
      });

      // Tagged so the catch below can tell "the send failed" (recoverable —
      // record it as failed) from "the recording failed" (must propagate).
      const failure = new Error(
        `Failed to record recovery action for event ${revenueEventId}: ${err?.message ?? err}`
      );
      (failure as any).recordFailure = true;
      throw failure;
    }
  };

  if (decision.action === "escalate_human") {
    await recordAction(
      {
        agent_decision_id: agentDecisionId,
        channel: "human_escalation",
        action_type: "escalated",
        status: "sent",
        attempt_number: params.attemptNumber,
      },
      "human_escalation"
    );

    await audit(revenueEventId, "action_executed", {
      channel: "human_escalation",
      note: "Queued for manual review, no automated action taken.",
    });
    return;
  }

  const channel = decision.action === "send_retry_link_whatsapp" ? "whatsapp" : "email";

  /**
   * When, as distinct from what. Resolved before anything is created or sent,
   * because a deferred send must not burn a payment link now for a message
   * going out in six hours — test-mode links are rationed, and a link created
   * hours early is a link that may be stale by the time anyone taps it.
   */
  const window = resolveWindow(
    params.rootCause ?? "unknown",
    eventTimeIso ?? new Date().toISOString()
  );

  if (window.scheduledFor) {
    /**
     * Recorded as a real action even though nothing has been sent yet.
     *
     * That is the important part: the cooldown and the retry ceiling both
     * count rows in this table, and a commitment to contact someone in six
     * hours is a contact for their purposes. Leaving the row out until
     * dispatch would let a second event slip past both guardrails in the
     * meantime and queue a second message to the same person.
     */
    await recordAction(
      {
        agent_decision_id: agentDecisionId,
        channel,
        action_type: "retry_link_sent",
        status: "scheduled",
        attempt_number: params.attemptNumber,
        scheduled_for: window.scheduledFor,
      },
      channel
    );

    await audit(revenueEventId, "action_scheduled", {
      channel,
      scheduled_for: window.scheduledFor,
      reason: window.reason,
      note: "No payment link created and nothing sent yet. The dispatcher will do both when the window opens, and re-checks quiet hours at that point.",
    });
    return;
  }

  try {
    /**
     * Razorpay test mode allows 30 payment links in total, so a batch larger
     * than that cannot create one per event. Checked before the call rather
     * than after the failure: letting each attempt fail would record an
     * account quota against the customer, and the dashboard would report
     * hundreds of people not receiving a link they were never sent.
     */
    // Seeded from the database before claiming, so the budget survives a
    // process restart or a dev-server module reload. A count that resets is
    // a budget per module instantiation, which is not a quantity anyone means.
    try {
      seedLinkBudget(await db.countLiveLinks());
    } catch {
      // Unknown count — the in-memory tally still applies. Deliberately not
      // fatal: an unreadable counter must not stop a recovery attempt, and
      // over-spending a test budget is a far smaller harm than dropping the
      // action entirely.
    }

    const live = claimLinkBudget();

    const link = live
      ? await createLink({
          amountPaise: params.amountPaise,
          currency: params.currency,
          customerContact: params.customerContact,
          channel: channel === "whatsapp" ? "sms" : "email",
          description: `Payment retry — revenue recovery agent (event ${revenueEventId})`,
        })
      : {
          // Marked, not disguised. Nothing downstream may mistake this for a
          // link that exists on Razorpay's side.
          paymentLinkId: `simulated_${revenueEventId.slice(0, 8)}`,
          shortUrl: "",
          status: "simulated",
        };

    let deliveryResult: {
      success: boolean;
      error?: string;
      messageId?: string;
      status?: string;
    } = { success: true };

    if (channel === "whatsapp" && live) {
      deliveryResult = await sendWhatsApp({
        toPhoneE164: params.customerContact,
        paymentLinkUrl: link.shortUrl,
        amountRupees: params.amountPaise / 100,
      });
    }
    // email delivery is already handled by the MCP server's `notify.email` flag

    await recordAction(
      {
        agent_decision_id: agentDecisionId,
        channel,
        action_type: "retry_link_sent",
        razorpay_payment_link_id: link.paymentLinkId,
        status: deliveryResult.success ? (live ? "sent" : "simulated") : "failed",
        attempt_number: params.attemptNumber,
        /**
         * Stored so Meta's later delivery callback has something to join on.
         * Without it, `accepted` is where this record's knowledge permanently
         * ends and a claim in the trail cannot be traced to a message Meta
         * can be asked about.
         */
        provider_message_id: deliveryResult.messageId ?? null,
        delivery_state: deliveryResult.status ?? null,
      },
      channel
    );

    await audit(revenueEventId, "action_executed", {
      channel,
      payment_link_id: link.paymentLinkId,
      // "accepted" is what Meta actually tells us, and it is weaker than
      // delivered — an unverified recipient is accepted and silently dropped.
      // The message id is recorded so a claim in this trail can be traced
      // back to a message Meta can be asked about.
      delivery_accepted: deliveryResult.success,
      delivery_status: deliveryResult.status,
      whatsapp_message_id: deliveryResult.messageId,
      delivery_success: deliveryResult.success,
      delivery_error: deliveryResult.error,
      // Says which links are real. Once the test-mode budget is spent the
      // pipeline still runs end to end, and the record says so rather than
      // implying a link that does not exist.
      link_source: live ? "razorpay_mcp" : "simulated",
    });
  } catch (err: any) {
    // A failure to RECORD is already fully logged and must keep propagating —
    // swallowing it here would recreate the blind-counter bug this guards
    // against, and would try to insert the same failing row a second time.
    if (err?.recordFailure) throw err;

    await recordAction(
      {
        agent_decision_id: agentDecisionId,
        channel,
        action_type: "retry_link_sent",
        status: "failed",
        attempt_number: params.attemptNumber,
      },
      channel
    );

    /**
     * An exhausted test account is a configuration problem, not a customer
     * outcome. A shared or partly-used test key can be out of links before
     * this process starts, and passing that through as an opaque tool error
     * is what produced 295 rows implying people had not received a message.
     */
    const message = String(err?.message ?? "unknown_error");

    await audit(revenueEventId, "action_executed", {
      channel,
      delivery_success: false,
      error: isLinkQuotaError(message)
        ? "razorpay_test_link_quota_exhausted: this test account has used its 30 payment links. Set RAZORPAY_MCP_LINK_BUDGET=0 or use a fresh test key — no customer was affected."
        : isRateLimitError(message)
          ? "razorpay_rate_limited: too many link creations in a burst. Our traffic shape, not a delivery problem — no customer was affected."
          : message,
    });
  }
}
