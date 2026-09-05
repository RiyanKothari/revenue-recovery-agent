import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { apiError } from "@/lib/api-errors";
import { parseStatusPayload, verifyMetaSignature, verifySubscription } from "@/lib/whatsapp-status";

export const dynamic = "force-dynamic";

/**
 * Meta's delivery callback — the only place the word "delivered" can honestly
 * come from.
 *
 * Sending returns `accepted`, which is weaker than delivered: Meta answers
 * 200 for any recipient and silently drops messages to numbers not on a test
 * number's allowed list. Three messages were once recorded here as successes
 * and none arrived. This endpoint is what closes that gap — it records what
 * the provider later said, keyed on the message id captured at send time.
 *
 * Two rules govern the responses below.
 *
 * **Refuse what cannot be authenticated.** An unsigned or wrongly-signed
 * callback is rejected, and a missing app secret refuses everything rather
 * than defaulting to trust. Anyone who could post here unauthenticated could
 * mark real messages as delivered, which is precisely the claim this project
 * exists to make honestly.
 *
 * **Answer 200 to anything that was authentic.** Meta retries a non-2xx for
 * hours and then disables the subscription. A status for a message this
 * deployment never sent, a payload shape we do not recognise, a duplicate
 * redelivery — all are normal traffic, and all get a 200 with a body saying
 * what was actually done. The distinction between "accepted and applied" and
 * "accepted and ignored" belongs in the response body, not in the status code.
 */

export async function GET(request: Request) {
  // The one-time handshake Meta performs when the callback URL is registered.
  const url = new URL(request.url);
  const result = verifySubscription(url.searchParams, process.env.WHATSAPP_VERIFY_TOKEN);

  if (!result.ok) {
    return new NextResponse("forbidden", { status: 403 });
  }

  // Meta requires the challenge echoed as plain text, not JSON.
  return new NextResponse(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(request: Request) {
  /**
   * Read as raw text, because the signature covers the exact bytes Meta sent.
   * Parsing to an object and re-serialising would change key order and
   * whitespace, and the HMAC would never match again.
   */
  const raw = await request.text();

  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) {
    // Deliberately says nothing about which check failed.
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Authentic but unparseable. 200, because retrying will not fix it.
    return NextResponse.json({ applied: 0, note: "unparseable_body" });
  }

  const { updates, malformed } = parseStatusPayload(body);

  if (updates.length === 0) {
    // Meta sends message-received callbacks on the same subscription. Nothing
    // to do with them here, and nothing wrong with them either.
    return NextResponse.json({ applied: 0, unmatched: 0, malformed });
  }

  try {
    const db = getDb();

    let applied = 0;
    let unmatched = 0;

    for (const update of updates) {
      const revenueEventId = await db.recordDeliveryStatus(update);

      if (!revenueEventId) {
        unmatched += 1;
        continue;
      }

      applied += 1;

      /**
       * Appended rather than overwritten. `recovery_actions.delivery_state`
       * holds the latest word; this is the sequence of words, so a message
       * that went accepted, then sent, then failed leaves all three in the
       * trail. Collapsing that to the final state would lose the fact that we
       * once believed it had worked.
       */
      await logAudit(revenueEventId, "delivery_status_updated", {
        provider: "whatsapp",
        provider_message_id: update.provider_message_id,
        // Meta's vocabulary, unmapped — see lib/whatsapp-status.ts.
        delivery_state: update.state,
        reported_at: update.at,
        error: update.error ?? undefined,
        source: "meta_delivery_callback",
      });
    }

    return NextResponse.json({ applied, unmatched, malformed });
  } catch (err) {
    /**
     * The one case that must NOT return 200. The callback was authentic and
     * we failed to record it, so Meta retrying is exactly what we want.
     */
    return apiError("delivery_status_write_failed", 500, err);
  }
}
