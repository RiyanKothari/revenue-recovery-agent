import { test } from "node:test";
import assert from "node:assert/strict";
import { dispersion, isFavourable, type OfferRecord } from "../lib/offer-ledger";
import { auditFairness } from "../lib/fairness-audit";
import { checkDataIsolation, measureConvergence, watchCategory } from "../lib/cartel-watch";

/**
 * The Pattern Engine: one ledger, read along two axes.
 *
 * Across customers within a merchant, the question is fairness. Across
 * merchants within a category, it is collusion. The tests that matter most
 * are the ones asserting these tools REFUSE to report — an auditor that finds
 * something every time produces a queue nobody reads, and a collusion
 * detector without a control arm is making an unfalsifiable claim.
 */

let seq = 0;
function offer(overrides: Partial<OfferRecord> = {}): OfferRecord {
  seq += 1;
  return {
    offerId: `off_${seq}`,
    merchantId: "m_kettle",
    category: "coffee",
    customerId: `cust_${seq}`,
    segment: {},
    offeredAtIso: "2026-06-01T00:00:00.000Z",
    discountPercent: 20,
    agentVersion: "cart-agent@1",
    inputMerchantIds: ["m_kettle"],
    ...overrides,
  };
}

/** `count` offers for one segment value, `favourable` of them generous. */
function cohort(params: {
  attribute: string;
  value: string;
  count: number;
  favourable: number;
  merchantId?: string;
}): OfferRecord[] {
  return Array.from({ length: params.count }, (_, i) =>
    offer({
      merchantId: params.merchantId ?? "m_kettle",
      segment: { [params.attribute]: params.value },
      discountPercent: i < params.favourable ? 25 : 2,
    })
  );
}

// --- the ledger primitives

test("a favourable offer is one at or above the threshold", () => {
  assert.equal(isFavourable(offer({ discountPercent: 10 })), true);
  assert.equal(isFavourable(offer({ discountPercent: 9.9 })), false);
  assert.equal(isFavourable(offer({ discountPercent: 5 }), 5), true);
});

test("one merchant has no dispersion to report, and that is not convergence", () => {
  /**
   * The single most misleading number this system could produce. A lone
   * merchant's pricing has zero spread by definition, and printing that as
   * perfect convergence would manufacture the strongest possible finding out
   * of no data at all.
   */
  assert.equal(dispersion([]), null);
  assert.equal(dispersion([20]), null);
  assert.equal(dispersion([10, 20]), 5);
});

// --- fairness: across customers

test("a real disparity between large groups is reported", () => {
  const offers = [
    ...cohort({ attribute: "city_tier", value: "tier_1", count: 200, favourable: 160 }),
    ...cohort({ attribute: "city_tier", value: "tier_3", count: 200, favourable: 60 }),
  ];

  const report = auditFairness({ merchantId: "m_kettle", attribute: "city_tier", offers });

  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding.verdict, "disparity");
  assert.equal(finding.compared.group, "tier_3");
  assert.ok(finding.gapPp < 0, "tier_3 is worse off");
  assert.match(finding.reason, /less often/);
});

test("a small group that merely looks different is not accused", () => {
  /**
   * The property that decides whether anyone keeps this switched on. Small
   * groups differ constantly and for no reason, and a tool that reports every
   * one of them produces a queue of noise that gets ignored within a week.
   */
  const offers = [
    ...cohort({ attribute: "city_tier", value: "tier_1", count: 200, favourable: 100 }),
    ...cohort({ attribute: "city_tier", value: "tier_3", count: 6, favourable: 1 }),
  ];

  const finding = auditFairness({
    merchantId: "m_kettle",
    attribute: "city_tier",
    offers,
  }).findings[0];

  assert.equal(finding.verdict, "underpowered");
  // n=6 produces an interval that EXCLUDES ZERO. Checking significance before
  // the sample floor would accuse a merchant of discrimination on six
  // observations because the arithmetic said so.
  assert.match(finding.reason, /below 30 the normal approximation/);
  assert.match(finding.reason, /fact about the sample, not about the merchant/);
});

test("a clean result says how large a gap it could have found", () => {
  /**
   * "No disparity" is only meaningful alongside the size of what was
   * detectable, or the sentence is unfalsifiable. Two thousand per group is
   * not arbitrary: at a 50% base rate it is roughly what it takes to resolve
   * a five point gap, and anything smaller cannot honestly claim a clean
   * result at that materiality.
   */
  const offers = [
    ...cohort({ attribute: "device", value: "android", count: 2000, favourable: 1000 }),
    ...cohort({ attribute: "device", value: "ios", count: 2000, favourable: 990 }),
  ];

  const finding = auditFairness({ merchantId: "m_kettle", attribute: "device", offers })
    .findings[0];

  assert.equal(finding.verdict, "no_disparity");
  assert.ok(finding.minimumDetectableEffectPp !== null);
  assert.ok(finding.minimumDetectableEffectPp! <= 5, "fine enough to see a material gap");
  assert.match(finding.reason, /the absence is informative/);
});

test("a real but trivial gap at huge n is not called a disparity", () => {
  /**
   * Significance answers "is this real" and never answers "does this
   * matter". At large enough n a fraction of a point becomes statistically
   * detectable, and a tool that reports it teaches everyone to ignore the
   * findings that deserve attention.
   */
  const offers = [
    ...cohort({ attribute: "device", value: "android", count: 20000, favourable: 10000 }),
    ...cohort({ attribute: "device", value: "ios", count: 20000, favourable: 9700 }),
  ];

  const finding = auditFairness({ merchantId: "m_kettle", attribute: "device", offers })
    .findings[0];

  assert.equal(finding.verdict, "no_disparity");
  assert.match(finding.reason, /below the 5pp treated as material/);
});

test("materiality is adjustable, and a stricter threshold surfaces the same gap", () => {
  const offers = [
    ...cohort({ attribute: "device", value: "android", count: 20000, favourable: 10000 }),
    ...cohort({ attribute: "device", value: "ios", count: 20000, favourable: 9700 }),
  ];

  const finding = auditFairness({
    merchantId: "m_kettle",
    attribute: "device",
    offers,
    materialGapPp: 1,
  }).findings[0];

  assert.equal(finding.verdict, "disparity");
});

test("the largest group is the reference, not the best-treated one", () => {
  /**
   * Using the best-treated group as the baseline would guarantee every other
   * group shows a deficit, which is a tool that always finds something.
   */
  const offers = [
    ...cohort({ attribute: "channel", value: "organic", count: 300, favourable: 150 }),
    ...cohort({ attribute: "channel", value: "paid", count: 20, favourable: 20 }),
  ];

  const report = auditFairness({ merchantId: "m_kettle", attribute: "channel", offers });
  assert.equal(report.findings[0].reference.group, "organic");
});

test("another merchant's offers never enter this merchant's audit", () => {
  const offers = [
    ...cohort({ attribute: "city_tier", value: "tier_1", count: 100, favourable: 80 }),
    ...cohort({
      attribute: "city_tier",
      value: "tier_1",
      count: 100,
      favourable: 0,
      merchantId: "m_rival",
    }),
  ];

  const report = auditFairness({ merchantId: "m_kettle", attribute: "city_tier", offers });
  assert.deepEqual(report.findings, [], "only one group survives the merchant filter");
  assert.match(report.summary, /Nothing to compare/);
});

// --- cartel watch: across merchants

test("a decision computed from a competitor's data is a proof, not a statistic", () => {
  const offers = [
    offer({ merchantId: "m_kettle", inputMerchantIds: ["m_kettle"] }),
    offer({
      offerId: "off_bad",
      merchantId: "m_kettle",
      inputMerchantIds: ["m_kettle", "m_rival", "m_rival"],
    }),
    offer({ merchantId: "m_rival", inputMerchantIds: ["m_rival"] }),
  ];

  const violations = checkDataIsolation(offers);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].offerId, "off_bad");
  // Deduplicated and sorted, so two runs over the same ledger produce
  // identical findings and a new one is visible in a diff.
  assert.deepEqual(violations[0].foreignMerchantIds, ["m_rival"]);
});

test("learning from a merchant in another category is not a violation", () => {
  // The concern is rivals. A platform learning from unrelated traffic is
  // ordinary, and flagging it would bury the findings that matter.
  const offers = [
    offer({ merchantId: "m_kettle", category: "coffee", inputMerchantIds: ["m_kettle", "m_tyres"] }),
    offer({ merchantId: "m_tyres", category: "automotive", inputMerchantIds: ["m_tyres"] }),
  ];

  assert.deepEqual(checkDataIsolation(offers), []);
});

test("convergence without a control arm is refused, not reported", () => {
  /**
   * The most important branch in the module. A whole category can converge
   * for reasons that have nothing to do with the platform, and reporting a
   * bare convergence number would be exactly the unfalsifiable claim this
   * project exists to avoid.
   */
  const spread = [8, 16, 24];
  const tight = [15, 16, 17];

  const offers = [
    ...spread.map((d, i) =>
      offer({ merchantId: `m_${i}`, discountPercent: d, offeredAtIso: "2026-01-01T00:00:00.000Z" })
    ),
    ...tight.map((d, i) =>
      offer({ merchantId: `m_${i}`, discountPercent: d, offeredAtIso: "2026-08-01T00:00:00.000Z" })
    ),
  ];

  const result = measureConvergence({
    category: "coffee",
    offers,
    cutoverIso: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(result.verdict, "no_control");
  assert.equal(result.excessConvergence, null);
  assert.match(result.reason, /A market can converge on its own/);
});

test("convergence beyond the control cohort is a signal, and says it is only a signal", () => {
  const agentBefore = [8, 16, 24];
  const agentAfter = [15, 16, 17]; // dispersion collapses
  const controlBefore = [8, 16, 24];
  const controlAfter = [8, 16, 24]; // unchanged

  const offers = [
    ...agentBefore.map((d, i) =>
      offer({
        merchantId: `a_${i}`,
        discountPercent: d,
        offeredAtIso: "2026-01-01T00:00:00.000Z",
        agentVersion: "cart-agent@1",
      })
    ),
    ...agentAfter.map((d, i) =>
      offer({
        merchantId: `a_${i}`,
        discountPercent: d,
        offeredAtIso: "2026-08-01T00:00:00.000Z",
        agentVersion: "cart-agent@1",
      })
    ),
    ...controlBefore.map((d, i) =>
      offer({
        merchantId: `c_${i}`,
        discountPercent: d,
        offeredAtIso: "2026-01-01T00:00:00.000Z",
        agentVersion: null,
      })
    ),
    ...controlAfter.map((d, i) =>
      offer({
        merchantId: `c_${i}`,
        discountPercent: d,
        offeredAtIso: "2026-08-01T00:00:00.000Z",
        agentVersion: null,
      })
    ),
  ];

  const result = measureConvergence({
    category: "coffee",
    offers,
    cutoverIso: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(result.verdict, "converging");
  assert.ok((result.excessConvergence ?? 0) > 1);
  assert.match(result.reason, /signal to investigate, not a finding/);
});

test("a category converging as a whole produces no signal against its own control", () => {
  // Both cohorts tighten by the same amount: the market moved, the agent did
  // not move it.
  const build = (agent: string | null, prefix: string) => [
    ...[8, 16, 24].map((d, i) =>
      offer({
        merchantId: `${prefix}_${i}`,
        discountPercent: d,
        offeredAtIso: "2026-01-01T00:00:00.000Z",
        agentVersion: agent,
      })
    ),
    ...[14, 16, 18].map((d, i) =>
      offer({
        merchantId: `${prefix}_${i}`,
        discountPercent: d,
        offeredAtIso: "2026-08-01T00:00:00.000Z",
        agentVersion: agent,
      })
    ),
  ];

  const result = measureConvergence({
    category: "coffee",
    offers: [...build("cart-agent@1", "a"), ...build(null, "c")],
    cutoverIso: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(result.verdict, "no_signal");
  assert.equal(result.excessConvergence, 0);
});

test("a proof outranks a signal, and the two are never averaged", () => {
  /**
   * Severity is deliberately not a score. An isolation violation is a proof
   * about recorded inputs; convergence is a statistical hint with innocent
   * explanations. Averaging them into a number would destroy the distinction
   * that makes the report worth reading.
   */
  const report = watchCategory({
    category: "coffee",
    offers: [
      offer({ merchantId: "m_kettle", inputMerchantIds: ["m_kettle", "m_rival"] }),
      offer({ merchantId: "m_rival", inputMerchantIds: ["m_rival"] }),
    ],
    cutoverIso: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(report.severity, "proof");
  assert.match(report.summary, /does not depend on any statistical interpretation/);
});

test("a clean category says so plainly", () => {
  const report = watchCategory({
    category: "coffee",
    offers: [
      offer({ merchantId: "m_kettle", inputMerchantIds: ["m_kettle"] }),
      offer({ merchantId: "m_rival", inputMerchantIds: ["m_rival"] }),
    ],
    cutoverIso: "2026-06-01T00:00:00.000Z",
  });

  assert.equal(report.severity, "clear");
  assert.deepEqual(report.isolationViolations, []);
  assert.match(report.summary, /No competitor data reached any decision/);
});
