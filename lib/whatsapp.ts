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
        to: params.toPhoneE164,
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
