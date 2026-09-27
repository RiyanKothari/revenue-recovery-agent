import { dispersion, groupBy, type OfferRecord } from "./offer-ledger";

/**
 * Cartel Watch — across merchants, within one category.
 *
 * ## The shape of the problem
 *
 * When one agent platform is deployed across merchants who compete with each
 * other, it is structurally a hub-and-spoke arrangement. The competitors
 * never speak to one another. The shared algorithm speaks for them. The US
 * enforcement action against RealPage in 2026 treated exactly that shape as
 * the problem, and the remedies went to the mechanism — limits on how
 * granular the shared output could be, and a court-appointed monitor —
 * rather than to any agreement between the competitors, because there wasn't
 * one.
 *
 * Nothing about that requires bad intent from the platform. It is a property
 * of the deployment: train one pricing agent on what works, roll it out
 * across a category, and the competing merchants' offers can converge without
 * a single person deciding they should.
 *
 * ## Why this is a gift rather than an accusation
 *
 * The output here is not "these merchants are colluding". That is a legal
 * determination and this is not qualified to make one. It is the evidence a
 * platform operator would need to demonstrate the opposite, before a
 * regulator asks them to — and, if something is actually wrong, to find it
 * while it is still small.
 *
 * ## Three layers, weakest to strongest
 *
 * 1. **Convergence.** Are competitors' offers becoming more alike? A signal,
 *    and a weak one, because competitive markets converge for entirely
 *    innocent reasons: input costs move together, everybody discounts at
 *    Diwali, and a good idea spreads.
 * 2. **Attribution.** Is the convergence specific to the merchants on the
 *    agent? This is the same holdout logic the recovery pipeline already
 *    runs, lifted one level up: merchants in the same category who are NOT on
 *    the agent are the control arm. Without them, convergence is just an
 *    observation about a market.
 * 3. **Data isolation.** Was any merchant's decision computed from a
 *    competitor's non-public data? This one is not a statistic at all. It is
 *    a deterministic check over recorded decision inputs, it has no false
 *    positives, and it is the mechanism the RealPage theory actually turned
 *    on rather than the price similarity that made the headlines.
 *
 * A finding at layer 3 is a proof. Findings at layers 1 and 2 are reasons to
 * go and look, and this module is careful to say which it is holding.
 */

export interface IsolationViolation {
  offerId: string;
  merchantId: string;
  category: string;
  /** Competitors whose data fed this merchant's decision. */
  foreignMerchantIds: string[];
  offeredAtIso: string;
}

/**
 * Layer 3. Every decision's inputs must trace to the merchant it was made
 * for.
 *
 * Deterministic, exhaustive, and free of judgement: a decision for merchant A
 * that cites merchant B's data either happened or it did not. That is what
 * makes this the strongest thing in the module despite being the simplest —
 * there is no threshold to argue about and no sample size to be wrong about.
 *
 * Only competitors count. A decision informed by a merchant in a different
 * category is a platform learning from unrelated traffic, which is ordinary;
 * the concern is specifically about rivals.
 */
export function checkDataIsolation(offers: OfferRecord[]): IsolationViolation[] {
  const categoryOf = new Map<string, string>();
  for (const offer of offers) categoryOf.set(offer.merchantId, offer.category);

  const violations: IsolationViolation[] = [];

  for (const offer of offers) {
    const foreign = offer.inputMerchantIds.filter(
      (id) => id !== offer.merchantId && categoryOf.get(id) === offer.category
    );

    if (foreign.length > 0) {
      violations.push({
        offerId: offer.offerId,
        merchantId: offer.merchantId,
        category: offer.category,
        // Deduplicated and ordered so two runs over the same ledger produce
        // byte-identical findings — a report that reshuffles itself cannot be
        // diffed between runs, and diffing is how anyone spots a new one.
        foreignMerchantIds: [...new Set(foreign)].sort(),
        offeredAtIso: offer.offeredAtIso,
      });
    }
  }

  return violations;
}

export interface CohortDispersion {
  /** Dispersion of discounts across merchants, or null below two merchants. */
  before: number | null;
  after: number | null;
  merchantsBefore: number;
  merchantsAfter: number;
}

export interface ConvergenceResult {
  category: string;
  onAgent: CohortDispersion;
  offAgent: CohortDispersion;
  /**
   * Difference in differences: how much more the agent cohort's dispersion
   * fell than the control cohort's. Positive means the agent cohort converged
   * faster than the market did. Null when either cohort lacks a comparison.
   */
  excessConvergence: number | null;
  verdict: "converging" | "no_signal" | "no_control";
  reason: string;
}

/**
 * Mean discount per merchant within a window, which is the unit that
 * converges. Dispersion across *merchants* is the question; dispersion across
 * individual offers would mostly measure how varied each merchant's own
 * customers are.
 */
function merchantMeans(offers: OfferRecord[]): number[] {
  return [...groupBy(offers, (o) => o.merchantId).values()].map(
    (group) => group.reduce((sum, o) => sum + o.discountPercent, 0) / group.length
  );
}

/**
 * How much convergence has to exceed the control cohort's before it is worth
 * reporting, in percentage points of dispersion.
 *
 * Non-zero on purpose. Two cohorts never move identically, and a threshold of
 * zero would report a signal every single time one happened to fall further
 * than the other.
 */
export const EXCESS_CONVERGENCE_THRESHOLD = 1.0;

/**
 * Layers 1 and 2 together, because layer 1 alone is not worth reporting.
 *
 * `cutoverIso` splits the ledger into before and after — the moment the agent
 * was rolled out in this category. Merchants with `agentVersion` set are the
 * treated cohort; those without are the control, and they are the only reason
 * this can say anything causal at all.
 */
export function measureConvergence(params: {
  category: string;
  offers: OfferRecord[];
  cutoverIso: string;
}): ConvergenceResult {
  const { category, cutoverIso } = params;
  const cutover = Date.parse(cutoverIso);

  const inCategory = params.offers.filter((o) => o.category === category);

  const cohort = (onAgent: boolean): CohortDispersion => {
    const rows = inCategory.filter((o) => (o.agentVersion !== null) === onAgent);
    const before = rows.filter((o) => Date.parse(o.offeredAtIso) < cutover);
    const after = rows.filter((o) => Date.parse(o.offeredAtIso) >= cutover);

    const beforeMeans = merchantMeans(before);
    const afterMeans = merchantMeans(after);

    return {
      before: dispersion(beforeMeans),
      after: dispersion(afterMeans),
      merchantsBefore: beforeMeans.length,
      merchantsAfter: afterMeans.length,
    };
  };

  const onAgent = cohort(true);
  const offAgent = cohort(false);

  const agentFall =
    onAgent.before !== null && onAgent.after !== null ? onAgent.before - onAgent.after : null;
  const controlFall =
    offAgent.before !== null && offAgent.after !== null ? offAgent.before - offAgent.after : null;

  if (agentFall === null) {
    return {
      category,
      onAgent,
      offAgent,
      excessConvergence: null,
      verdict: "no_signal",
      reason:
        "Not enough merchants on the agent in this category, on both sides of the cutover, to measure dispersion at all.",
    };
  }

  if (controlFall === null) {
    /**
     * The honest refusal, and the most important branch here.
     *
     * Without merchants in the same category who are off the agent, a fall in
     * dispersion is indistinguishable from the whole category converging for
     * reasons that have nothing to do with the platform. Reporting a bare
     * convergence number here is exactly the kind of unfalsifiable claim this
     * project exists to avoid making.
     */
    return {
      category,
      onAgent,
      offAgent,
      excessConvergence: null,
      verdict: "no_control",
      reason:
        "No comparable merchants off the agent in this category, so convergence cannot be attributed to it. A market can converge on its own, and nothing here could tell the difference.",
    };
  }

  const excess = agentFall - controlFall;

  if (excess < EXCESS_CONVERGENCE_THRESHOLD) {
    return {
      category,
      onAgent,
      offAgent,
      excessConvergence: excess,
      verdict: "no_signal",
      reason: `Merchants on the agent converged no faster than the rest of the category (${excess.toFixed(2)}pp difference in dispersion).`,
    };
  }

  return {
    category,
    onAgent,
    offAgent,
    excessConvergence: excess,
    verdict: "converging",
    reason:
      `Offers among merchants on the agent converged ${excess.toFixed(2)}pp more than comparable merchants off it. ` +
      "This is a signal to investigate, not a finding: competitive markets converge for innocent reasons, and nothing here establishes a mechanism.",
  };
}

export interface CartelReport {
  category: string;
  isolationViolations: IsolationViolation[];
  convergence: ConvergenceResult;
  /** `proof` outranks `signal`, which outranks `clear`. */
  severity: "proof" | "signal" | "clear";
  summary: string;
}

/**
 * The whole category.
 *
 * Severity is deliberately not a score. An isolation violation and a
 * convergence signal are different kinds of claim — one is a proof about
 * recorded inputs, the other is a statistical hint with innocent
 * explanations — and averaging them into a number would destroy exactly the
 * distinction that makes the report trustworthy.
 */
export function watchCategory(params: {
  category: string;
  offers: OfferRecord[];
  cutoverIso: string;
}): CartelReport {
  const inCategory = params.offers.filter((o) => o.category === params.category);

  const isolationViolations = checkDataIsolation(inCategory);
  const convergence = measureConvergence(params);

  if (isolationViolations.length > 0) {
    const merchants = new Set(isolationViolations.map((v) => v.merchantId));
    return {
      category: params.category,
      isolationViolations,
      convergence,
      severity: "proof",
      summary:
        `${isolationViolations.length} decision${isolationViolations.length === 1 ? "" : "s"} across ${merchants.size} merchant${merchants.size === 1 ? "" : "s"} were computed using a competitor's data. ` +
        "This is the mechanism itself, recorded, and it does not depend on any statistical interpretation.",
    };
  }

  if (convergence.verdict === "converging") {
    return {
      category: params.category,
      isolationViolations,
      convergence,
      severity: "signal",
      summary: `No competitor data reached any decision in this category. ${convergence.reason}`,
    };
  }

  return {
    category: params.category,
    isolationViolations,
    convergence,
    severity: "clear",
    summary: `No competitor data reached any decision in this category. ${convergence.reason}`,
  };
}
