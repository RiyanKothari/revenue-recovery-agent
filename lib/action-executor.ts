import { supabase } from "./supabase";
import { logAudit } from "./audit";
import { createAndSendRetryLink } from "./razorpay-mcp-client";
import { sendWhatsAppRetryNudge } from "./whatsapp";
import type { Decision } from "./decision-engine";

/**
 * Turns an agent decision into a real action. This is where "detects
 * revenue at risk AND executes a bounded recovery workflow" stops being a
 * claim and becomes something you can point at in the audit log.
 */
export async function executeAction(params: {
  revenueEventId: string;
  agentDecisionId: string;
  decision: Decision;
  amountPaise: number;
  currency: string;
  customerContact: string;
  attemptNumber: number;
}) {
  const { decision, revenueEventId, agentDecisionId } = params;

  if (decision.action === "escalate_human") {
    await supabase.from("recovery_actions").insert({
      agent_decision_id: agentDecisionId,
      channel: "human_escalation",
      action_type: "escalated",
      status: "sent",
      attempt_number: params.attemptNumber,
    });
    await logAudit(revenueEventId, "action_executed", {
      channel: "human_escalation",
      note: "Queued for manual review, no automated action taken.",
    });
    return;
  }

  const channel = decision.action === "send_retry_link_whatsapp" ? "whatsapp" : "email";

  try {
    // Always create the retry link through Razorpay's own MCP server first
    // — this is the real, verifiable Razorpay-side artifact of the action.
    const link = await createAndSendRetryLink({
      amountPaise: params.amountPaise,
      currency: params.currency,
      customerContact: params.customerContact,
      channel: channel === "whatsapp" ? "sms" : "email",
      description: `Payment retry — revenue recovery agent (event ${revenueEventId})`,
    });

    let deliveryResult: { success: boolean; error?: string } = { success: true };

    if (channel === "whatsapp") {
      deliveryResult = await sendWhatsAppRetryNudge({
        toPhoneE164: params.customerContact,
        paymentLinkUrl: link.shortUrl,
        amountRupees: params.amountPaise / 100,
      });
    }
    // email delivery is already handled by the MCP server's `notify.email` flag

    await supabase.from("recovery_actions").insert({
      agent_decision_id: agentDecisionId,
      channel,
      action_type: "retry_link_sent",
      razorpay_payment_link_id: link.paymentLinkId,
      status: deliveryResult.success ? "sent" : "failed",
      attempt_number: params.attemptNumber,
    });

    await logAudit(revenueEventId, "action_executed", {
      channel,
      payment_link_id: link.paymentLinkId,
      delivery_success: deliveryResult.success,
      delivery_error: deliveryResult.error,
    });
  } catch (err: any) {
    await supabase.from("recovery_actions").insert({
      agent_decision_id: agentDecisionId,
      channel,
      action_type: "retry_link_sent",
      status: "failed",
      attempt_number: params.attemptNumber,
    });
    await logAudit(revenueEventId, "action_executed", {
      channel,
      delivery_success: false,
      error: err?.message ?? "unknown_error",
    });
  }
}
