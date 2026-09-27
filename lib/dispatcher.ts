import { getDb, type RecoveryDb } from "./db";
import { logAudit } from "./audit";
import { createAndSendRetryLink } from "./razorpay-mcp-client";
import { sendWhatsAppRetryNudge } from "./whatsapp";
import { claimLinkBudget, seedLinkBudget } from "./link-budget";
import { inQuietHours } from "./send-window";
import { issueVerification } from "./nudge-verify-service";

/**
 * Sends what was scheduled earlier.
 *
 * The decision is not revisited here, and that is a deliberate boundary. It
 * was made under the guardrails, recorded, and audited; re-running the gates
 * six hours later against a changed world would mean the audit trail describes
 * a decision the system did not act on. What the dispatcher may still do is
 * *refuse* — quiet hours are re-checked, because a send scheduled for 20:55
 * that the queue reaches at 21:05 must not go out on the strength of having
 * been allowed when it was queued.
 *
 * Exactly-once is enforced in the database, not here. `claimDueAction` is a
 * conditional update that only one caller can win, so two overlapping cron
 * ticks cannot both send the same message — the same reasoning as the unique
 * constraint on decisions, and for the same reason: no amount of
 * application-level checking closes that window.
 */

export type DispatcherDb = Pick<
  RecoveryDb,
  | "listDueActions"
  | "claimDueAction"
  | "completeDueAction"
  | "countLiveLinks"
  | "issueNudgeVerification"
>;

export interface DispatcherDeps {
  db: DispatcherDb;
  createLink: typeof createAndSendRetryLink;
  sendWhatsApp: typeof sendWhatsAppRetryNudge;
  audit: typeof logAudit;
  now: () => Date;
  /**
   * Issues the Verified Nudge challenge, exactly as the immediate send path
   * does. A scheduled message is no less impersonable than a prompt one, and
   * a customer who receives a checkable message at 2pm and an uncheckable one
   * at 7pm has been taught that the check means nothing.
   */
  issueVerification: typeof issueVerification;
}

function resolveDeps(overrides: Partial<DispatcherDeps>): DispatcherDeps {
  return {
    db: overrides.db ?? getDb(),
    createLink: overrides.createLink ?? createAndSendRetryLink,
    sendWhatsApp: overrides.sendWhatsApp ?? sendWhatsAppRetryNudge,
    audit: overrides.audit ?? logAudit,
    now: overrides.now ?? (() => new Date()),
    issueVerification: overrides.issueVerification ?? issueVerification,
  };
}

export interface DispatchSummary {
  due: number;
  sent: number;
  simulated: number;
  failed: number;
  /** Claimed by another tick between the read and the update. */
  skipped_claimed: number;
  /** Reached inside quiet hours and pushed back rather than sent. */
  held_quiet_hours: number;
}

/**
 * One pass over the due queue.
 *
 * Bounded per invocation on purpose. A cron tick that tries to drain an
 * unbounded backlog is a cron tick that times out halfway through with some
 * messages sent and no record of where it stopped; a small batch that runs to
 * completion every minute drains the same backlog with a boundary the
 * database can see.
 */
export async function dispatchDueActions(
  overrides: Partial<DispatcherDeps> = {},
  batchSize = 25
): Promise<DispatchSummary> {
  const { db, createLink, sendWhatsApp, audit, now, issueVerification: issue } =
    resolveDeps(overrides);

  const at = now();
  const nowIso = at.toISOString();

  const due = await db.listDueActions(nowIso, batchSize);

  const summary: DispatchSummary = {
    due: due.length,
    sent: 0,
    simulated: 0,
    failed: 0,
    skipped_claimed: 0,
    held_quiet_hours: 0,
  };

  for (const action of due) {
    /**
     * Re-checked, not trusted. The scheduler avoided quiet hours when it chose
     * the moment; a backlog, a stalled cron, or a clock that moved can all
     * deliver the row inside them anyway.
     */
    if (inQuietHours(nowIso)) {
      summary.held_quiet_hours += 1;
      continue;
    }

    // The claim is the lock. A loser here has not failed — the other tick is
    // handling this row — so it is counted separately from an error.
    if (!(await db.claimDueAction(action.id, nowIso))) {
      summary.skipped_claimed += 1;
      continue;
    }

    try {
      try {
        seedLinkBudget(await db.countLiveLinks());
      } catch {
        // Unknown count; the in-memory tally still applies. An unreadable
        // counter must not stop a send that was already decided on.
      }

      const live = claimLinkBudget();

      const link = live
        ? await createLink({
            amountPaise: action.amount_paise,
            currency: action.currency,
            customerContact: action.customer_contact ?? "",
            channel: action.channel === "whatsapp" ? "sms" : "email",
            description: `Payment retry — revenue recovery agent (event ${action.revenue_event_id})`,
          })
        : {
            // Marked, never disguised — nothing downstream may mistake this
            // for a link that exists on Razorpay's side.
            paymentLinkId: `simulated_${action.revenue_event_id.slice(0, 8)}`,
            shortUrl: "",
            status: "simulated",
          };

      let delivery: { success: boolean; error?: string; messageId?: string; status?: string } = {
        success: true,
      };

      if (action.channel === "whatsapp" && live) {
        // Bound to the failure it answers, on the same terms as an immediate
        // send: null means the challenge could not be recorded, and the
        // message then goes without a code rather than with one that would
        // fail the customer's check.
        const verification = await issue(
          {
            revenueEventId: action.revenue_event_id,
            amountPaise: action.amount_paise,
            failedAtIso: action.scheduled_for,
          },
          { db }
        );

        delivery = await sendWhatsApp({
          toPhoneE164: action.customer_contact ?? "",
          paymentLinkUrl: link.shortUrl,
          amountRupees: action.amount_paise / 100,
          verification: verification ?? undefined,
        });
      }

      await db.completeDueAction({
        action_id: action.id,
        status: delivery.success ? (live ? "sent" : "simulated") : "failed",
        razorpay_payment_link_id: link.paymentLinkId,
        provider_message_id: delivery.messageId ?? null,
        delivery_state: delivery.status ?? null,
        executed_at: nowIso,
      });

      if (!delivery.success) summary.failed += 1;
      else if (live) summary.sent += 1;
      else summary.simulated += 1;

      await audit(action.revenue_event_id, "action_executed", {
        channel: action.channel,
        payment_link_id: link.paymentLinkId,
        // Meta's own word. `accepted` is weaker than delivered — the delivery
        // callback fills in the rest, keyed on the message id below.
        delivery_accepted: delivery.success,
        delivery_status: delivery.status,
        whatsapp_message_id: delivery.messageId,
        delivery_success: delivery.success,
        delivery_error: delivery.error,
        link_source: live ? "razorpay_mcp" : "simulated",
        dispatched_from: "scheduled_queue",
        scheduled_for: action.scheduled_for,
        // How late the queue was. Published because a scheduler whose lag is
        // invisible is a scheduler nobody can tell has stopped.
        lag_seconds: Math.round(
          (at.getTime() - new Date(action.scheduled_for).getTime()) / 1000
        ),
      });
    } catch (err: any) {
      summary.failed += 1;

      /**
       * The row stays claimed. Releasing it on failure would put it straight
       * back into the next tick's batch, and a send that fails because the
       * recipient is unreachable would be retried every minute forever — the
       * retry ceiling counts decisions, not dispatch attempts, so nothing
       * downstream would stop it. A failure here is terminal for this action
       * and legible in the trail.
       */
      await db.completeDueAction({
        action_id: action.id,
        status: "failed",
        executed_at: nowIso,
      });

      await audit(action.revenue_event_id, "action_executed", {
        channel: action.channel,
        delivery_success: false,
        dispatched_from: "scheduled_queue",
        error: String(err?.message ?? err),
      });
    }
  }

  return summary;
}
