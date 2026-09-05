import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliveryStatusUpdate } from "./db/types";

/**
 * What Meta tells us *after* a send, and how to believe it.
 *
 * The send call returns `accepted` with a message id, and that is all it can
 * honestly return: Meta answers 200 for any recipient and then silently drops
 * messages to numbers that are not on a test number's allowed list. Three
 * messages were once recorded as delivered here and none arrived. Actual
 * delivery is asynchronous and arrives on this callback, which is the only
 * place the word "delivered" can come from without inventing it.
 *
 * The vocabulary is Meta's, not ours — `sent`, `delivered`, `read`, `failed`
 * — and it is stored unmapped. Translating it into a status of our own would
 * put a layer of our interpretation between the provider's claim and the
 * audit trail, and the whole argument of this project is that the trail
 * records what was observed rather than what was concluded.
 */

/** The statuses Meta emits. Anything else is stored but not acted on. */
export const TERMINAL_FAILURE_STATES = new Set(["failed", "undelivered"]);

export interface ParsedStatuses {
  updates: DeliveryStatusUpdate[];
  /** Statuses seen for messages carrying no id — reported, never guessed at. */
  malformed: number;
}

/**
 * Pulls delivery statuses out of Meta's envelope.
 *
 * Written defensively on purpose: this is a public endpoint, the payload
 * shape is Meta's to change, and one malformed entry must not cost the rest
 * of the batch. A callback that throws is a callback Meta retries forever.
 */
export function parseStatusPayload(body: unknown): ParsedStatuses {
  const updates: DeliveryStatusUpdate[] = [];
  let malformed = 0;

  const entries = (body as any)?.entry;
  if (!Array.isArray(entries)) return { updates, malformed };

  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const statuses = change?.value?.statuses;
      if (!Array.isArray(statuses)) continue;

      for (const status of statuses) {
        const id = typeof status?.id === "string" ? status.id : null;
        const state = typeof status?.status === "string" ? status.status : null;

        if (!id || !state) {
          malformed += 1;
          continue;
        }

        updates.push({
          provider_message_id: id,
          state,
          at: metaTimestampToIso(status?.timestamp),
          // Meta puts the reason in an array of errors, and the useful part is
          // the code — the title is prose that changes.
          error: describeStatusError(status?.errors),
        });
      }
    }
  }

  return { updates, malformed };
}

/**
 * Meta sends unix seconds as a string. A missing or unparseable timestamp
 * becomes "when we received it" rather than the epoch, because a status
 * dated 1970 in the audit trail is worse than one dated a second late.
 */
export function metaTimestampToIso(timestamp: unknown, now = Date.now()): string {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date(now).toISOString();
  return new Date(seconds * 1000).toISOString();
}

export function describeStatusError(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] as any;
  const code = first?.code ?? "unknown";
  const title = first?.title ?? first?.message ?? "";
  return `meta_${code}${title ? `: ${title}` : ""}`;
}

/**
 * Meta signs every callback with the app secret, and this refuses when the
 * secret is missing.
 *
 * The same bug as the Razorpay webhook, which is why it is spelled out again
 * rather than assumed learned: `createHmac("sha256", "")` does not throw. It
 * computes a perfectly valid HMAC with an empty key, so an unconfigured
 * deployment would verify signatures forged by anyone — and look rigorous
 * doing it. An unset secret is refused at the point of use, not left to
 * deployment discipline.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string | undefined
): boolean {
  if (!appSecret) {
    console.error(
      "[whatsapp-status] WHATSAPP_APP_SECRET is not set — refusing every delivery callback. An empty secret would otherwise accept forged ones."
    );
    return false;
  }

  if (!header) return false;

  // Meta sends `sha256=<hex>`. The prefix is required, not decoration: a bare
  // hex string would mean a different signing scheme.
  const [algorithm, provided] = header.split("=");
  if (algorithm !== "sha256" || !provided) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  // Lengths must match before timingSafeEqual, which throws on a mismatch —
  // and a throw is itself a timing signal.
  if (provided.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * The GET handshake Meta performs once when the callback URL is registered.
 *
 * Returns the challenge only when the verify token matches exactly. A missing
 * configured token refuses, for the same reason as above — an empty token
 * compared against an empty query parameter would succeed.
 */
export function verifySubscription(
  params: URLSearchParams,
  configuredToken: string | undefined
): { ok: boolean; challenge?: string } {
  if (!configuredToken) {
    console.error(
      "[whatsapp-status] WHATSAPP_VERIFY_TOKEN is not set — refusing the subscription handshake."
    );
    return { ok: false };
  }

  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe" || token !== configuredToken || !challenge) {
    return { ok: false };
  }

  return { ok: true, challenge };
}
