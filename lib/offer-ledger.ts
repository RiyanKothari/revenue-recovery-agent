/**
 * The offer ledger — one record per offer an agent extended to a customer.
 *
 * ## Why one table answers two completely different questions
 *
 * Discrimination and collusion look like unrelated problems, and they are the
 * same data read along two different axes.
 *
 * **Across customers, within one merchant**, the question is fairness: did
 * comparable people get comparable offers? No single offer can answer it,
 * because every offer can sit inside the merchant's own configured bands
 * while the aggregate pattern still discriminates. That is precisely why
 * per-decision compliance checks cannot catch it, and why a platform that
 * validates each action in isolation will report a clean record throughout.
 *
 * **Across merchants, within one category**, the question is collusion. When
 * one agent platform is deployed across merchants who compete with each
 * other, it is structurally a hub-and-spoke arrangement: the competitors
 * never speak, and the shared algorithm speaks for them. The US enforcement
 * action against RealPage in 2026 treated exactly that shape as a per se
 * problem, with remedies including limits on output granularity and a
 * court-appointed monitor.
 *
 * So: build the ledger once, get both. Fairness reads it grouped by customer
 * attribute; the cartel check reads it grouped by merchant.
 *
 * Nothing in this module or its two readers touches a clock, a model or a
 * database.
 */

export interface OfferRecord {
  offerId: string;
  merchantId: string;
  /**
   * The competitive set. Two merchants sharing a category are assumed to
   * compete, which is what makes convergence between them meaningful and
   * convergence across categories meaningless.
   */
  category: string;
  customerId: string;
  /**
   * Customer attributes this offer may be analysed against — city tier,
   * device, language, acquisition channel.
   *
   * Deliberately open rather than a fixed enum. The attribute that turns out
   * to carry a disparity is rarely the one anyone thought to enumerate, and a
   * fairness tool that can only audit the categories its author anticipated
   * audits the author's imagination.
   */
  segment: Record<string, string>;
  offeredAtIso: string;
  /** Normalised to a percentage so flat and percentage offers compare. */
  discountPercent: number;
  /**
   * Whether this customer received the favourable treatment, when that is
   * not a question about a discount.
   *
   * Some agents decide how much to give. Others decide whether to act at all,
   * and for those the fairness question is "was this person helped", which
   * has nothing to do with a percentage. A recovery agent that contacts card
   * users and skips UPI users is discriminating just as surely as one that
   * offers them less money, and forcing that through `discountPercent` would
   * mean recording a zero for everyone and auditing a column that never
   * varies.
   *
   * Left undefined for offer-based agents, where the discount IS the answer.
   */
  favourable?: boolean;
  /**
   * Which agent decided this, or null when a human or a static rule did.
   *
   * Null is not missing data. It is the control group: merchants in the same
   * category who are NOT on the agent are the only baseline against which
   * "the agent caused this" can be said at all, and without them convergence
   * is just an observation about a market.
   */
  agentVersion: string | null;
  /**
   * Whose data this decision was computed from.
   *
   * The most important field in the ledger. Convergence between competitors
   * is a statistic and it has innocent explanations — competitive markets
   * converge, input costs move together, everyone runs the same sale at
   * Diwali. A decision for merchant A computed from merchant B's non-public
   * data is not a statistic. It is the mechanism itself, and it was the
   * actual legal theory in the RealPage matter rather than the price
   * similarity that made the headlines.
   *
   * Recorded per decision so the question is answerable by inspection instead
   * of inference.
   */
  inputMerchantIds: string[];
}

/** The favourable-offer threshold, in percentage points. */
export const FAVOURABLE_DISCOUNT_PERCENT = 10;

/**
 * Whether an offer counts as favourable.
 *
 * Fairness is assessed on a proportion rather than on mean discount, because
 * a proportion is what the existing two-proportion machinery in
 * `lib/experiment.ts` already tests correctly — including its refusal to
 * quote a result the sample cannot support. Inventing a second, untested
 * statistical path for this would be the more impressive-looking and less
 * trustworthy choice.
 */
export function isFavourable(offer: OfferRecord, threshold = FAVOURABLE_DISCOUNT_PERCENT): boolean {
  // An explicit flag wins, because an agent that records one is telling us
  // its decision was not about money. Falling back to the discount keeps
  // every offer-based caller unchanged.
  if (offer.favourable !== undefined) return offer.favourable;
  return offer.discountPercent >= threshold;
}

/** Groups records by an arbitrary key, preserving insertion order. */
export function groupBy<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const k = key(record);
    const existing = groups.get(k);
    if (existing) existing.push(record);
    else groups.set(k, [record]);
  }
  return groups;
}

/**
 * Population standard deviation of a list of numbers, or null when there is
 * nothing to measure.
 *
 * Population rather than sample, because the merchants in a category at a
 * given moment are the whole population of interest, not a draw from a larger
 * one. Returns null below two observations: the dispersion of a single
 * merchant's pricing is zero by definition, and reporting that as "perfect
 * convergence" would be the single most misleading number this system could
 * produce.
 */
export function dispersion(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
