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
}

/** Resolved per call, not at module scope: getDb() throws without a
 *  configured DATABASE_URL, and importing this module must never do that. */
function resolveDeps(overrides: Partial<ExecutorDeps>): ExecutorDeps {
  return {
    db: overrides.db ?? getDb(),
    createLink: overrides.createLink ?? createAndSendRetryLink,
    sendWhatsApp: overrides.sendWhatsApp ?? sendWhatsAppRetryNudge,
    audit: overrides.audit ?? logAudit,
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
  },
  deps: Partial<ExecutorDeps> = {}
) {
  const { db, createLink, sendWhatsApp, audit } = resolveDeps(deps);
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
