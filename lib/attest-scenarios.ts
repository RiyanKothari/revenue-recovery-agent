import type { AttemptReservation, NudgeVerificationRow } from "./db/types";
import type { VerifierDb } from "./nudge-verify-service";
import type { Claim, OfferFacts } from "./message-claims";
import type { OfferRecord } from "./offer-ledger";

/**
 * Fixtures for the Attest console.
 *
 * ## Why this file exists
 *
 * All four agents are pure functions over data they are handed. None of them
 * opens a socket, reads a clock or calls a model. That is a property worth
 * having for its own sake, and it has a useful consequence: the console can
 * run every one of them with no database, no API keys and no network, which
 * means the demonstration cannot break because a credential expired an hour
 * before someone looked at it.
 *
 * ## The rule this file holds itself to
 *
 * **Nothing here is a stand-in for an agent.** Every verdict the console
 * shows is computed by the same function the production path calls. What is
 * fixture is only the *input*: the offer configuration, the ledger rows, the
 * claims a model would have extracted. Substituting a hand-written verdict
 * anywhere would make the console a slideshow of assertions, which is the
 * exact failure this whole product exists to argue against.
 *
 * Where a model would normally sit — claim extraction — the console shows its
 * output as an editable input and says so on screen, because the interesting
 * half is what happens *after* extraction, and pretending a model ran when it
 * did not would be a lie of the kind this project spends its effort
 * preventing.
 */

// --- Verified Nudge ---------------------------------------------------------

/**
 * An in-memory store with the real attempt semantics: the reservation
 * increments before the comparison and refusal past the cap is the store's
 * job, not the caller's.
 *
 * Deliberately not a stub that always says yes. If the console's store were
 * permissive, the panel would demonstrate nothing — the whole point of the
 * attempt cap is that it refuses, and a fixture that cannot refuse cannot
 * show it.
 */
export function createFixtureVerifierDb(seed: NudgeVerificationRow[]): VerifierDb {
  const rows = new Map(seed.map((row) => [row.code, { ...row }]));

  return {
    async reserveVerificationAttempt(code: string, cap: number): Promise<AttemptReservation> {
      const row = rows.get(code);
      if (!row) return null;

      if (row.attempts >= cap) return { row: { ...row }, reserved: false };

      row.attempts += 1;
      return { row: { ...row }, reserved: true };
    },

    async refundVerificationAttempt(code: string) {
      const row = rows.get(code);
      if (row) row.attempts = Math.max(0, row.attempts - 1);
    },
  };
}

export interface NudgeScenario {
  id: string;
  label: string;
  /** The message as the customer would see it on their phone. */
  messageText: string;
  code: string;
  /** What the customer actually tried to pay, for the hint under the field. */
  trueAmount: string;
  note: string;
}

/**
 * The genuine code is in the store; the phishing one is not.
 *
 * That asymmetry is the entire demonstration, and it is worth noticing that
 * the phishing message here is *better written* than the real one. It has to
 * be: the premise of the agent is that copy, branding and a plausible link
 * cannot distinguish the two, so a demo whose fake message looks obviously
 * fake would prove nothing.
 */
export const NUDGE_FIXTURES: NudgeVerificationRow[] = [
  {
    code: "K7MQ2X4B",
    revenue_event_id: "11111111-2222-3333-4444-555555555555",
    merchant_name: "Kettle & Co",
    amount_paise: 249900,
    failed_at: "2026-09-26T08:32:00.000Z",
    expires_at: "2026-09-29T08:32:00.000Z",
    attempts: 0,
  },
];

export const NUDGE_SCENARIOS: NudgeScenario[] = [
  {
    id: "genuine",
    label: "Genuine message",
    messageText:
      "Kettle & Co: your payment of ₹2,499 didn't go through. Tap to try again: rzp.io/l/9fK2qd\nDon't trust this message. Check it at /attest — code K7MQ-2X4B",
    code: "K7MQ-2X4B",
    trueAmount: "2499",
    note: "Sent by the recovery agent against a real failed payment.",
  },
  {
    id: "phishing",
    label: "Phishing message",
    messageText:
      "Kettle & Co: URGENT — your payment of ₹2,499 failed and your order will be cancelled in 30 minutes. Secure it now: rzp.io/l/x8Vb1p\nVerification code: QH4T-9R2M",
    code: "QH4T-9R2M",
    trueAmount: "2499",
    note: "Real Razorpay-shaped link, real brand, better written than the genuine one. Nothing about the copy gives it away.",
  },
];

// --- Dark Pattern Sentinel --------------------------------------------------

export interface SentinelScenario {
  id: string;
  label: string;
  messageText: string;
  /** What a model returns from the message. Editable in the console. */
  claims: Claim[];
  note: string;
}

export const SENTINEL_MESSAGE =
  "Your cart is still waiting. Take 20% off — a special price, just for you. This offer expires in 24 hours.";

/**
 * One message, one extraction, two configurations.
 *
 * The console switches only the offer config and leaves the message and the
 * claims untouched, because that is the argument: the words are not the
 * evidence. A tone classifier sees the same sentence in both columns and
 * cannot tell them apart.
 */
export const SENTINEL_CLAIMS: Claim[] = [
  { type: "discount", text: "Take 20% off", kind: "percent", value: 20 },
  { type: "exclusivity", text: "a special price, just for you" },
  {
    type: "deadline",
    text: "This offer expires in 24 hours",
    hoursFromSend: 24,
    absoluteIso: null,
  },
];

export interface SentinelConfig {
  id: string;
  label: string;
  facts: OfferFacts;
  note: string;
}

export const SENTINEL_CONFIGS: SentinelConfig[] = [
  {
    id: "honest",
    label: "Offer config A",
    facts: {
      discount: { kind: "percent", value: 20 },
      offerScope: "personalised",
      offerExpiresAtIso: "2026-09-28T09:00:00.000Z",
    },
    note: "20% configured, offer really is customer-specific, and it really does expire in 24 hours.",
  },
  {
    id: "dishonest",
    label: "Offer config B",
    facts: {
      discount: { kind: "percent", value: 20 },
      offerScope: "universal",
      offerExpiresAtIso: null,
    },
    note: "Same 20%, but the coupon is available to everyone and has no expiry at all.",
  },
];

/** The moment the console treats as "now" for deadline arithmetic. */
export const SENTINEL_NOW = "2026-09-27T09:00:00.000Z";

// --- Fairness Auditor -------------------------------------------------------

export interface FairnessScenario {
  id: string;
  label: string;
  attribute: string;
  offers: OfferRecord[];
  note: string;
}

let fixtureSeq = 0;
function offerRow(params: {
  merchantId: string;
  attribute: string;
  value: string;
  favourable: boolean;
  category?: string;
  agentVersion?: string | null;
  offeredAtIso?: string;
  discountPercent?: number;
  inputMerchantIds?: string[];
}): OfferRecord {
  fixtureSeq += 1;
  return {
    offerId: `fx_${fixtureSeq}`,
    merchantId: params.merchantId,
    category: params.category ?? "coffee",
    customerId: `cust_${fixtureSeq}`,
    segment: { [params.attribute]: params.value },
    offeredAtIso: params.offeredAtIso ?? "2026-08-01T00:00:00.000Z",
    discountPercent: params.discountPercent ?? (params.favourable ? 25 : 2),
    /**
     * An explicit check, not `??`.
     *
     * `null` is the meaningful value here: it marks a merchant who is NOT on
     * the agent, which is the entire control arm. `params.agentVersion ??
     * "cart-agent@1"` swallowed it and quietly enrolled every control
     * merchant into the treated cohort, which left Cartel Watch with no
     * comparison and turned a convergence signal into "no control". Same
     * class of bug as the dry-run flag in lib/whatsapp.ts: a falsy value that
     * means something being replaced by a default that means the opposite.
     */
    agentVersion: params.agentVersion === undefined ? "cart-agent@1" : params.agentVersion,
    inputMerchantIds: params.inputMerchantIds ?? [params.merchantId],
  };
}

function segmentCohort(
  attribute: string,
  value: string,
  count: number,
  favourable: number
): OfferRecord[] {
  return Array.from({ length: count }, (_, i) =>
    offerRow({ merchantId: "m_kettle", attribute, value, favourable: i < favourable })
  );
}

export const FAIRNESS_SCENARIOS: FairnessScenario[] = [
  {
    id: "disparity",
    label: "A real disparity",
    attribute: "city_tier",
    offers: [
      ...segmentCohort("city_tier", "tier_1", 400, 320),
      ...segmentCohort("city_tier", "tier_3", 400, 120),
    ],
    note: "Every individual offer sits inside the merchant's configured bands. The pattern is only visible in aggregate, which is exactly why per-offer compliance checks report a clean record.",
  },
  {
    id: "underpowered",
    label: "A small group that looks different",
    attribute: "city_tier",
    offers: [
      ...segmentCohort("city_tier", "tier_1", 400, 200),
      ...segmentCohort("city_tier", "tier_3", 6, 1),
    ],
    note: "Six customers, one favourable offer. The interval excludes zero. A tool that reported this would be accusing a merchant on six observations.",
  },
  {
    id: "clean",
    label: "Clean, and large enough to say so",
    attribute: "device",
    offers: [
      ...segmentCohort("device", "android", 2000, 1000),
      ...segmentCohort("device", "ios", 2000, 990),
    ],
    note: "No disparity, and the comparison could have resolved one finer than the threshold treated as material. That is what makes the absence informative.",
  },
];

// --- Cartel Watch -----------------------------------------------------------

export interface CartelScenario {
  id: string;
  label: string;
  category: string;
  cutoverIso: string;
  offers: OfferRecord[];
  note: string;
}

function cohortOffers(params: {
  prefix: string;
  discounts: number[];
  offeredAtIso: string;
  agentVersion: string | null;
  leakFrom?: string;
}): OfferRecord[] {
  return params.discounts.map((discount, i) =>
    offerRow({
      merchantId: `${params.prefix}_${i}`,
      attribute: "city_tier",
      value: "tier_1",
      favourable: true,
      discountPercent: discount,
      offeredAtIso: params.offeredAtIso,
      agentVersion: params.agentVersion,
      inputMerchantIds: params.leakFrom
        ? [`${params.prefix}_${i}`, params.leakFrom]
        : [`${params.prefix}_${i}`],
    })
  );
}

const CUTOVER = "2026-06-01T00:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";
const AFTER = "2026-08-01T00:00:00.000Z";

export const CARTEL_SCENARIOS: CartelScenario[] = [
  {
    id: "clear",
    label: "Nothing to report",
    category: "coffee",
    cutoverIso: CUTOVER,
    offers: [
      ...cohortOffers({ prefix: "a", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: "cart-agent@1" }),
      ...cohortOffers({ prefix: "a", discounts: [9, 15, 23], offeredAtIso: AFTER, agentVersion: "cart-agent@1" }),
      ...cohortOffers({ prefix: "c", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: null }),
      ...cohortOffers({ prefix: "c", discounts: [9, 15, 23], offeredAtIso: AFTER, agentVersion: null }),
    ],
    note: "Merchants on the agent moved no more than the rest of the category, and no competitor's data reached any decision.",
  },
  {
    id: "no_control",
    label: "Converging, but nothing to compare against",
    category: "coffee",
    cutoverIso: CUTOVER,
    offers: [
      ...cohortOffers({ prefix: "a", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: "cart-agent@1" }),
      ...cohortOffers({ prefix: "a", discounts: [15, 16, 17], offeredAtIso: AFTER, agentVersion: "cart-agent@1" }),
    ],
    note: "Dispersion collapsed. With no merchants off the agent in this category, that is indistinguishable from a market converging on its own — so it refuses to report rather than making an unfalsifiable claim.",
  },
  {
    id: "signal",
    label: "Converging faster than the market",
    category: "coffee",
    cutoverIso: CUTOVER,
    offers: [
      ...cohortOffers({ prefix: "a", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: "cart-agent@1" }),
      ...cohortOffers({ prefix: "a", discounts: [15, 16, 17], offeredAtIso: AFTER, agentVersion: "cart-agent@1" }),
      ...cohortOffers({ prefix: "c", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: null }),
      ...cohortOffers({ prefix: "c", discounts: [8, 16, 24], offeredAtIso: AFTER, agentVersion: null }),
    ],
    note: "Now there is a control arm, and the agent cohort converged well beyond it. Still only a signal: competitive markets converge for innocent reasons and nothing here establishes a mechanism.",
  },
  {
    id: "proof",
    label: "A competitor's data reached a decision",
    category: "coffee",
    cutoverIso: CUTOVER,
    offers: [
      ...cohortOffers({ prefix: "a", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: "cart-agent@1" }),
      ...cohortOffers({
        prefix: "a",
        discounts: [15, 16, 17],
        offeredAtIso: AFTER,
        agentVersion: "cart-agent@1",
        leakFrom: "a_0",
      }),
      ...cohortOffers({ prefix: "c", discounts: [8, 16, 24], offeredAtIso: BEFORE, agentVersion: null }),
      ...cohortOffers({ prefix: "c", discounts: [8, 16, 24], offeredAtIso: AFTER, agentVersion: null }),
    ],
    note: "Not a statistic. These decisions were computed from a rival's data, it is recorded, and it is the mechanism the RealPage theory actually turned on.",
  },
];
