import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiError, rateLimited } from "@/lib/api-errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { screenMessage } from "@/lib/message-claims";
import { extractClaims } from "@/lib/claim-extractor";
import { isScreenable, resolveOffer } from "@/lib/offer-config";
import { resolveIdentity } from "@/lib/ledger-writer";
import { resolveDecisionModel } from "@/lib/decision-model";

export const dynamic = "force-dynamic";

/**
 * The Dark Pattern Sentinel, against a merchant's real offer configuration.
 *
 * A message goes in, the claims it makes are extracted, and each one is
 * checked against what `merchant_offers` actually says. Until this route
 * existed the ground truth was a fixture, and a claims adjudicator with no
 * ground truth is a tone classifier with extra steps.
 *
 * **This fails closed in three separate places and they are not the same
 * failure.** A message is held when the offer cannot be found, when the offer
 * is not currently live, when the model cannot be reached, and when a claim
 * is contradicted or unsupported. Collapsing those into one "blocked" would
 * be convenient and would destroy the only thing that makes the output
 * actionable: whether to go and fix the copy, the configuration, or the
 * infrastructure.
 */

function safeDb() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

interface ScreenRequest {
  message?: string;
  offerId?: string;
  merchantId?: string;
}

export async function POST(request: Request) {
  const db = safeDb();

  const limit = await enforceRateLimit("screen", 20, 60_000, db);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  let body: ScreenRequest;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_body", 400);
  }

  if (!body.message?.trim() || !body.offerId?.trim()) {
    return apiError("message_and_offer_id_required", 400);
  }

  if (!db) return apiError("database_unavailable", 503);

  const merchantId = body.merchantId?.trim() || resolveIdentity().merchantId;
  const nowIso = new Date().toISOString();

  try {
    const row = await db.findMerchantOffer(merchantId, body.offerId);
    const offer = resolveOffer(row, nowIso);

    /**
     * Held before a single claim is read.
     *
     * Running the adjudicator against a missing offer would return every
     * claim as `unsupported` — the right decision by the wrong route, with a
     * reason blaming the merchant's configuration for an offer that was never
     * found. The distinction is what tells someone where to go and look.
     */
    if (!isScreenable(offer)) {
      return NextResponse.json({
        decision: "hold",
        held_by: "offer",
        offer_status: offer.status,
        claims: [],
        blocking: [],
        summary: `Held: ${offer.reason}`,
      });
    }

    const extraction = await extractClaims(body.message, resolveDecisionModel());

    if (!extraction.ok) {
      // "The screen did not run" is not "the screen passed", and it is also
      // not "the copy is wrong". Nobody should go and rewrite a message
      // because a model was unreachable.
      return NextResponse.json({
        decision: "hold",
        held_by: "extraction",
        offer_status: offer.status,
        claims: [],
        blocking: [],
        summary: `Held: the message could not be screened (${extraction.reason}). A screen that cannot run is not a screen that passed.`,
      });
    }

    const result = screenMessage({
      claims: extraction.claims,
      facts: offer.facts!,
      nowIso,
    });

    return NextResponse.json({
      ...result,
      held_by: result.decision === "hold" ? "claims" : null,
      offer_status: offer.status,
      offer_id: body.offerId,
      merchant_id: merchantId,
      model: extraction.model,
    });
  } catch (err) {
    return apiError("screen_failed", 500, err);
  }
}

/** The offers this merchant has on record, so a caller can see what exists. */
export async function GET(request: Request) {
  const db = safeDb();

  const limit = await enforceRateLimit("screen", 20, 60_000, db);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
  if (!db) return apiError("database_unavailable", 503);

  const merchantId =
    new URL(request.url).searchParams.get("merchantId")?.trim() || resolveIdentity().merchantId;

  try {
    const rows = await db.listMerchantOffers(merchantId);
    const nowIso = new Date().toISOString();

    return NextResponse.json({
      merchant_id: merchantId,
      offers: rows.map((row) => {
        const resolved = resolveOffer(row, nowIso);
        return {
          offer_id: row.offer_id,
          status: resolved.status,
          // Surfaced because it is the single most consequential field: an
          // offer with no expiry cannot support any deadline claim, and
          // whoever writes the copy should know that before they write it.
          has_expiry: row.valid_until !== null,
          scope: row.scope,
          discount:
            row.discount_kind && row.discount_value !== null
              ? { kind: row.discount_kind, value: row.discount_value }
              : null,
        };
      }),
    });
  } catch (err) {
    return apiError("offer_list_failed", 500, err);
  }
}
