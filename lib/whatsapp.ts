/**
 * Meta's WhatsApp Cloud API, for the one message this system sends.
 *
 * This path had never once succeeded when it was written — the token expired
 * before a real send was attempted — so everything here is arranged so that
 * its first live run is boring rather than surprising. Each failure mode says
 * which of the three things went wrong: our configuration, Meta's API, or the
 * recipient.
 */

const API_VERSION = "v20.0";

/**
 * The template and its language are configurable because they are the two
 * things most likely to differ from what this file assumes. A template
 * approved as `en_US` and sent as `en` fails with an error naming neither,
 * and re-approval takes hours you will not have.
 */
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "payment_retry_nudge";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "en";

/**
 * The seeded batch's numbers.
 *
 * Matched on the prefix, not on an exact length. The previous guard required
 * exactly five trailing digits, which is what `43000 + i` produces only while
 * the batch is smaller than about 57,000 events — past that the number grows
 * a sixth digit, the pattern stops matching, and the guard fails OPEN on the
 * one check standing between a demo and messaging real people. A guard whose
 * correctness depends on the batch size is not a guard.
 */
const SYNTHETIC_PREFIX = /^\+?9198765\d+$/;

export function isSyntheticNumber(phone: string): boolean {
  return SYNTHETIC_PREFIX.test(phone.replace(/[\s-]/g, ""));
}

/**
 * Meta wants digits only — no plus, no spaces, no dashes. It is lenient about
 * the plus and strict about the rest, so everything is normalised rather than
 * relying on which of those it happens to forgive today.
 */
export function normaliseRecipient(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWhatsAppRetryNudge(params: {
  toPhoneE164: string;
  paymentLinkUrl: string;
  amountRupees: number;
}): Promise<SendResult> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return { success: false, error: "whatsapp_not_configured: no phone number id or access token" };
  }

  // --- Send safety, before anything leaves the process.
  if (process.env.WHATSAPP_DRY_RUN === "true") {
    console.log(
      `[whatsapp:dry-run] would send ₹${params.amountRupees.toFixed(2)} retry link to ${params.toPhoneE164}`
    );
    return { success: true, messageId: "dry-run" };
  }

  /**
   * `||`, not `??`.
   *
   * .env.local ships this variable present-but-blank, and `??` only falls
   * back on null or undefined — so an empty string counted as a configured
   * recipient and every live message would have been addressed to "". The
   * moment dry run was switched off, nothing would arrive and the error would
   * point at Meta rather than at the blank line in the config.
   */
  const testRecipient = process.env.WHATSAPP_TEST_RECIPIENT?.trim() || null;
  const destination = testRecipient ?? params.toPhoneE164;

  if (!testRecipient && isSyntheticNumber(params.toPhoneE164)) {
    return {
      success: false,
      error:
        "refused_synthetic_recipient: this is a seeded demo number. Set WHATSAPP_TEST_RECIPIENT to a number you control, or WHATSAPP_DRY_RUN=true.",
    };
  }

  const recipient = normaliseRecipient(destination);

  if (recipient.length < 10) {
    // Reaching Meta with this would return an opaque error about the message
    // rather than about the number.
    return {
      success: false,
      error: `invalid_recipient: "${destination}" is not a usable phone number`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`, {
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
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANG },
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
    });
  } catch (err: any) {
    // A network failure is ours, not the recipient's, and must not be
    // recorded as a customer who did not receive their message.
    return {
      success: false,
      error: `whatsapp_unreachable: ${String(err?.message ?? err).slice(0, 120)}`,
    };
  }

  /**
   * Meta does not always answer in JSON. A proxy 502 or a rate-limit page
   * comes back as HTML, and an unguarded parse throws from inside the
   * executor's try block — where it would be recorded as a delivery failure
   * with a message about unexpected tokens. This is the same unguarded-parse
   * bug that once killed a whole batch run; it is not allowed a second home.
   */
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    return {
      success: false,
      error: `whatsapp_bad_response: HTTP ${res.status} with a non-JSON body`,
    };
  }

  if (!res.ok) {
    return { success: false, error: describeMetaError(data, res.status) };
  }

  const messageId = data?.messages?.[0]?.id;

  if (!messageId) {
    // A 200 with no message id means Meta accepted the request and queued
    // nothing. Reporting success here would put a message in the audit trail
    // that WhatsApp has no record of.
    return { success: false, error: "whatsapp_no_message_id: accepted but nothing queued" };
  }

  return { success: true, messageId };
}

/**
 * Turns Meta's error into one that names the right culprit.
 *
 * The distinction that matters is configuration versus delivery. An expired
 * token, an unapproved template, or an unverified recipient are all OUR
 * problem, and recording them against the customer fills the dashboard with
 * hundreds of rows implying people did not receive a message that was never
 * sent. Only the last branch is a genuine delivery failure.
 */
export function describeMetaError(data: any, status: number): string {
  const error = data?.error ?? {};
  const message = String(error.message ?? "");
  const code = error.code;
  const subcode = error.error_subcode;

  if (code === 190 || /session has expired|access token.*expired/i.test(message)) {
    return "whatsapp_token_expired: regenerate WHATSAPP_ACCESS_TOKEN. Meta's API Setup tokens last ~24h; a System User token does not expire.";
  }

  if (code === 132001 || /template name .* does not exist|template does not exist/i.test(message)) {
    return `whatsapp_template_missing: "${TEMPLATE_NAME}" (${TEMPLATE_LANG}) is not approved on this account. Check the name AND the language code — an en_US template sent as en fails exactly like a missing one.`;
  }

  if (code === 132000 || /number of parameters/i.test(message)) {
    return "whatsapp_template_params_mismatch: the approved template does not take exactly two body variables (amount, link).";
  }

  if (code === 131030 || /not in allowed list|recipient phone number not/i.test(message)) {
    return "whatsapp_recipient_not_allowed: on a test number, recipients must be added to the verified list in the Meta app dashboard first.";
  }

  if (code === 131026 || /message undeliverable/i.test(message)) {
    return "whatsapp_undeliverable: the recipient has no WhatsApp account or cannot receive this message.";
  }

  if (code === 4 || code === 613 || /rate limit|too many/i.test(message)) {
    return "whatsapp_rate_limited: our send rate, not a delivery problem.";
  }

  return `whatsapp_error_${code ?? status}: ${message || "unknown"}`;
}
