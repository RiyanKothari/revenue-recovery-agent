import type { OfferFacts } from "./message-claims";

/**
 * The merchant's real offer configuration — the ground truth the Dark Pattern
 * Sentinel checks claims against.
 *
 * ## Why this is the load-bearing half
 *
 * The Sentinel's whole argument is that urgency is only a dark pattern when
 * it is false, and that only the record can tell the two apart. Until this
 * existed, the record was a fixture. A claims adjudicator with no ground
 * truth is a tone classifier with extra steps.
 *
 * ## The three states, again
 *
 * The adjudicator already distinguishes supported, contradicted and
 * unsupported. That only works if the store below it preserves the same
 * distinction, and the trap is a specific one:
 *
 *   - **A column that is null** means the merchant configured no expiry, no
 *     stock limit, no price history. That is a real fact about the offer, and
 *     it is exactly what makes a deadline claim a fabrication.
 *   - **A row that is missing** means we do not know anything about this
 *     offer at all.
 *
 * Both hold the message, so it is tempting to collapse them. They must not
 * be, because the person reading the hold needs to know whether to go and fix
 * the copy or go and fix the configuration — and because "this offer has no
 * expiry" is an accusation while "we could not find this offer" is an
 * apology.
 *
 * ## Validity is not the same as existence
 *
 * An offer whose window has closed still exists. Screening a message against
 * it must hold, and the reason has to say the offer is over rather than that
 * the claim was false — the copy may have been perfectly accurate last week.
 *
 * Nothing here reads a clock. `now` is an argument, as everywhere else.
 */

export interface MerchantOfferRow {
  offer_id: string;
  merchant_id: string;
  coupon_code: string | null;
  discount_kind: "percent" | "flat" | null;
  /** Percent as a percentage; flat in paise. */
  discount_value: number | null;
  valid_from: string | null;
  /** Null means no expiry was ever configured. That is the interesting case. */
  valid_until: string | null;
  scope: "personalised" | "universal" | null;
  units_remaining: number | null;
  previous_price_paise: number | null;
  recent_purchase_count: number | null;
}

export type OfferStatus = "active" | "not_yet_started" | "ended" | "missing";

export interface ResolvedOffer {
  status: OfferStatus;
  /** Null when the offer is missing; the adjudicator is never handed a guess. */
  facts: OfferFacts | null;
  row: MerchantOfferRow | null;
  reason: string;
}

/**
 * Turns a stored row into the shape the adjudicator reads.
 *
 * Every field passes through as null when it is null. That is the whole job:
 * a mapper that helpfully substituted a default would convert "this merchant
 * configured no expiry" into "this offer expires at some plausible time",
 * and the Sentinel's central case would silently start passing.
 */
export function toOfferFacts(row: MerchantOfferRow): OfferFacts {
  return {
    offerExpiresAtIso: row.valid_until,
    discount:
      row.discount_kind !== null && row.discount_value !== null
        ? { kind: row.discount_kind, value: row.discount_value }
        : null,
    offerScope: row.scope,
    unitsRemaining: row.units_remaining,
    previousPricePaise: row.previous_price_paise,
    recentPurchaseCount: row.recent_purchase_count,
  };
}

/**
 * Whether this offer is live, and what the adjudicator should be given.
 *
 * A missing offer yields `facts: null` rather than an empty object. Empty
 * facts would send every claim through the adjudicator and come back
 * `unsupported`, which is the right decision reached by the wrong route — the
 * message would be held with a reason blaming the merchant's configuration
 * for an offer that was never looked up.
 */
export function resolveOffer(
  row: MerchantOfferRow | null,
  nowIso: string
): ResolvedOffer {
  if (!row) {
    return {
      status: "missing",
      facts: null,
      row: null,
      reason:
        "No such offer is on record, so nothing in this message can be checked. This is a configuration problem rather than a finding about the copy.",
    };
  }

  const now = Date.parse(nowIso);

  if (row.valid_from !== null && now < Date.parse(row.valid_from)) {
    return {
      status: "not_yet_started",
      facts: toOfferFacts(row),
      row,
      reason: `This offer does not start until ${row.valid_from}. A message promoting it now is describing something that is not yet true.`,
    };
  }

  if (row.valid_until !== null && now > Date.parse(row.valid_until)) {
    /**
     * Deliberately not phrased as a false claim. The copy may have been
     * accurate when it was written, and telling a marketer their message
     * lies when the real problem is that it is being sent late would send
     * them to fix the wrong thing.
     */
    return {
      status: "ended",
      facts: toOfferFacts(row),
      row,
      reason: `This offer ended at ${row.valid_until}. The message may have been accurate when written; it is being sent after the offer closed.`,
    };
  }

  return {
    status: "active",
    facts: toOfferFacts(row),
    row,
    reason: "Offer is live, and its configuration is what the claims are checked against.",
  };
}

/**
 * Whether a resolved offer may be screened at all.
 *
 * Kept beside `resolveOffer` so a caller cannot invent its own rule: only a
 * live offer's configuration can adjudicate a claim, and everything else is a
 * hold with a reason of its own.
 */
export function isScreenable(resolved: ResolvedOffer): boolean {
  return resolved.status === "active" && resolved.facts !== null;
}
