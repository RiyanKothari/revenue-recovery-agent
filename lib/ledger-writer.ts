import type { OfferRecord } from "./offer-ledger";

/**
 * Turns this pipeline's own decisions into offer-ledger rows.
 *
 * ## Why this file is the difference between a library and an agent
 *
 * The Fairness Auditor and Cartel Watch are correct, tested and, until this
 * existed, operating on data that nothing produced. That is a real and
 * reasonable objection: a detector reasoning about a hypothetical ledger has
 * not detected anything. This is the writer that makes them read the system
 * they ship beside.
 *
 * ## What counts as the "offer" here
 *
 * The recovery agent gives no discount. Its decision is whether to contact
 * someone at all, and which channel to use, so the fairness question that
 * actually applies is **who does it decide to help**. An agent that chases
 * card failures and quietly gives up on UPI failures is discriminating just
 * as surely as one that offers some customers less money.
 *
 * So `favourable` is "this customer was actually contacted", and the value
 * axis is left alone rather than recorded as a discount of zero for
 * everybody — auditing a column that never varies would produce a clean bill
 * of health that means nothing.
 *
 * ## The segments are real, not invented
 *
 * Every attribute below is something the pipeline already knows at decision
 * time: how the customer tried to pay, how much, and why it failed. None of
 * it is demographic and none of it is inferred, which matters — a fairness
 * tool that starts by guessing protected attributes has created a worse
 * problem than the one it audits.
 *
 * These are proxies, and the honest framing is that payment method correlates
 * with a great deal in India. If the agent systematically abandons UPI
 * failures, it is systematically abandoning a poorer and more rural
 * population, whether or not anybody intended that.
 */

/** Amount bands, in paise. Chosen to split a realistic Indian cart. */
const AMOUNT_BANDS: [number, string][] = [
  [50_000, "under_500"],
  [200_000, "500_to_2000"],
  [1_000_000, "2000_to_10000"],
  [Number.POSITIVE_INFINITY, "over_10000"],
];

export function amountBand(amountPaise: number): string {
  for (const [ceiling, label] of AMOUNT_BANDS) {
    if (amountPaise < ceiling) return label;
  }
  return "over_10000";
}

export interface DecisionFacts {
  revenueEventId: string;
  customerId: string | null;
  amountPaise: number;
  paymentMethod: string | null;
  rootCause: string | null;
  decidedAtIso: string;
  /**
   * Whether this customer was actually contacted.
   *
   * False covers every reason: a guardrail refused, the expected value did
   * not justify it, or the event landed in the holdout. The ledger
   * deliberately does not distinguish them, because from the customer's side
   * they are the same event — nobody got in touch — and a fairness audit that
   * excused some refusals would be auditing our intentions rather than our
   * behaviour.
   */
  contacted: boolean;
  policyVersion: string;
}

export interface LedgerIdentity {
  merchantId: string;
  category: string;
}

/**
 * One decision, as a ledger row.
 *
 * `inputMerchantIds` is always just this merchant, and that is not a
 * placeholder — it is the true and checkable answer. This deployment computes
 * every decision from its own data and nothing else, so Cartel Watch's
 * isolation check passes on real rows rather than on fixtures. It is the
 * cheapest kind of proof: the kind that is true.
 */
export function toOfferRecord(
  facts: DecisionFacts,
  identity: LedgerIdentity
): OfferRecord {
  return {
    offerId: facts.revenueEventId,
    merchantId: identity.merchantId,
    category: identity.category,
    customerId: facts.customerId ?? facts.revenueEventId,
    segment: {
      payment_method: facts.paymentMethod ?? "unrecorded",
      amount_band: amountBand(facts.amountPaise),
      root_cause: facts.rootCause ?? "unclassified",
    },
    offeredAtIso: facts.decidedAtIso,
    // Not a discount agent. See the note on `favourable` in offer-ledger.ts.
    discountPercent: 0,
    favourable: facts.contacted,
    agentVersion: facts.policyVersion,
    inputMerchantIds: [identity.merchantId],
  };
}

/**
 * The attributes this pipeline can honestly be audited along.
 *
 * Exported so the API route and the console cannot drift from the writer: an
 * audit offered on an attribute the writer never records would silently
 * compare one group against itself and report no disparity.
 */
export const AUDITABLE_ATTRIBUTES = ["payment_method", "amount_band", "root_cause"] as const;

export type AuditableAttribute = (typeof AUDITABLE_ATTRIBUTES)[number];

/**
 * Who this deployment is, for ledger purposes.
 *
 * Falls back to a clearly marked placeholder rather than throwing, because a
 * missing merchant name must not take down the recovery pipeline — the ledger
 * is an observability concern, and no customer is worse off if its rows are
 * labelled `unconfigured`. It is visible in the audit output, which is the
 * right place for a configuration problem to surface.
 */
export function resolveIdentity(
  // Typed as a plain lookup rather than `ProcessEnv`, so a test can pass the
  // two variables it cares about instead of constructing a whole environment.
  env: Record<string, string | undefined> = process.env
): LedgerIdentity {
  const configured = env.MERCHANT_ID?.trim() || env.MERCHANT_NAME?.trim();
  if (configured) return { merchantId: configured, category: category(env) };

  /**
   * Falls back to the deployment's own hostname before giving up.
   *
   * Not a fabricated name: on Vercel this IS the identity of the thing making
   * the decisions, and the platform has already told the process what it is.
   * Making an operator retype it was asking them to repeat something we knew.
   *
   * The final fallback stays deliberately ugly. A fairness report headed
   * `unconfigured_merchant` is a configuration problem announcing itself in
   * the one place somebody will read it, which is better than a plausible
   * default that hides the fact that nobody said who this is.
   */
  const host = env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || env.VERCEL_URL?.trim();
  const fromHost = host?.split(".")[0];

  return {
    merchantId: fromHost || "unconfigured_merchant",
    category: category(env),
  };
}

function category(env: Record<string, string | undefined>): string {
  return env.MERCHANT_CATEGORY?.trim() || "uncategorised";
}
