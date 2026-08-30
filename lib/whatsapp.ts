/**
 * Thin wrapper around Meta's WhatsApp Cloud API — same integration pattern
 * used on Sneha Fashions and NicheFlow, rebuilt here rather than copied,
 * so it starts clean.
 */

const WHATSAPP_API_VERSION = "v20.0";

export async function sendWhatsAppRetryNudge(params: {
  toPhoneE164: string;
  paymentLinkUrl: string;
  amountRupees: number;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }

  // --- Send safety. The synthetic batch generates plausible real Indian
  // mobile numbers (+9198765xxxxx). Seeding 55 events against live
  // credentials without this would message 55 real strangers.
  if (process.env.WHATSAPP_DRY_RUN === "true") {
    console.log(
      `[whatsapp:dry-run] would send ₹${params.amountRupees.toFixed(2)} retry link to ${params.toPhoneE164}`
    );
    return { success: true, messageId: "dry-run" };
  }

  // Staging redirect: send everything to one number you actually control.
  const testRecipient = process.env.WHATSAPP_TEST_RECIPIENT;
  const recipient = testRecipient ?? params.toPhoneE164;

  if (!testRecipient && /^\+?9198765\d{5}$/.test(params.toPhoneE164)) {
    return {
      success: false,
      error:
        "refused_synthetic_recipient: this looks like a seeded demo number. Set WHATSAPP_TEST_RECIPIENT or WHATSAPP_DRY_RUN=true.",
    };
  }

  const res = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "template",
        template: {
          // This template must be pre-approved in the Meta Business
          // Manager before it can be sent — see docs/SETUP.md.
          name: "payment_retry_nudge",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: `₹${params.amountRupees.toFixed(2)}` },
                { type: "text", text: params.paymentLinkUrl },
              ],
            },
          ],
        },
      }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    return { success: false, error: data?.error?.message ?? "unknown_whatsapp_error" };
  }

  return { success: true, messageId: data?.messages?.[0]?.id };
}
