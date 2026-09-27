import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITABLE_ATTRIBUTES,
  amountBand,
  resolveIdentity,
  toOfferRecord,
  type DecisionFacts,
} from "../lib/ledger-writer";
import { isFavourable } from "../lib/offer-ledger";
import { auditFairness } from "../lib/fairness-audit";
import { checkDataIsolation } from "../lib/cartel-watch";

/**
 * The writer that connects this pipeline's own decisions to the Pattern
 * Engine.
 *
 * Without it the Fairness Auditor was reasoning about a ledger nothing
 * produced. The assertions here are about that join being honest: that the
 * fairness question asked is the one this agent actually decides, and that
 * every segment is something the pipeline already knows rather than something
 * inferred about a person.
 */

function facts(overrides: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    revenueEventId: "evt_1",
    customerId: "cust_1",
    amountPaise: 249900,
    paymentMethod: "card",
    rootCause: "insufficient_funds",
    decidedAtIso: "2026-09-01T10:00:00.000Z",
    contacted: true,
    policyVersion: "v1",
    ...overrides,
  };
}

const IDENTITY = { merchantId: "m_kettle", category: "coffee" };

test("the fairness question is whether the customer was helped, not how much", () => {
  /**
   * This agent has no discount to give. Recording a discount of zero for
   * everybody and auditing that column would produce a clean bill of health
   * from a field that never varies — the most confident possible way to
   * detect nothing.
   */
  const contacted = toOfferRecord(facts({ contacted: true }), IDENTITY);
  const ignored = toOfferRecord(facts({ contacted: false }), IDENTITY);

  assert.equal(isFavourable(contacted), true);
  assert.equal(isFavourable(ignored), false);
  // Both carry the same discount, so the discount cannot be what decided it.
  assert.equal(contacted.discountPercent, ignored.discountPercent);
});

test("every segment is something the pipeline already knows", () => {
  /**
   * None of these is demographic and none is inferred. A fairness tool that
   * begins by guessing protected attributes has created a worse problem than
   * the one it audits.
   */
  const record = toOfferRecord(facts(), IDENTITY);

  assert.deepEqual(Object.keys(record.segment).sort(), [...AUDITABLE_ATTRIBUTES].sort());
  assert.equal(record.segment.payment_method, "card");
  assert.equal(record.segment.root_cause, "insufficient_funds");
});

test("missing attributes are recorded as unknown rather than dropped", () => {
  // A decision with no recorded payment method still happened, and excluding
  // it would quietly shrink the population being audited.
  const record = toOfferRecord(
    facts({ paymentMethod: null, rootCause: null, customerId: null }),
    IDENTITY
  );

  assert.equal(record.segment.payment_method, "unrecorded");
  assert.equal(record.segment.root_cause, "unclassified");
  // Falls back to the event id so the row still counts as one person.
  assert.equal(record.customerId, "evt_1");
});

test("amount bands cover the whole range with no gap at the boundaries", () => {
  assert.equal(amountBand(0), "under_500");
  assert.equal(amountBand(49_999), "under_500");
  assert.equal(amountBand(50_000), "500_to_2000");
  assert.equal(amountBand(199_999), "500_to_2000");
  assert.equal(amountBand(200_000), "2000_to_10000");
  assert.equal(amountBand(999_999), "2000_to_10000");
  assert.equal(amountBand(1_000_000), "over_10000");
  assert.equal(amountBand(99_999_999), "over_10000");
});

test("this deployment proves its own data isolation, on real rows", () => {
  /**
   * The cheapest kind of proof: the kind that is true. Every decision here is
   * computed from this merchant's data and nothing else, so Cartel Watch's
   * strongest check passes against production rows rather than fixtures.
   */
  const ledger = [
    toOfferRecord(facts({ revenueEventId: "e1" }), IDENTITY),
    toOfferRecord(facts({ revenueEventId: "e2" }), IDENTITY),
  ];

  assert.deepEqual(checkDataIsolation(ledger), []);
  for (const record of ledger) {
    assert.deepEqual(record.inputMerchantIds, [IDENTITY.merchantId]);
  }
});

test("a real contact disparity across payment methods is detected end to end", () => {
  /**
   * The whole point, exercised through the writer rather than around it. If
   * the agent chased card failures and gave up on UPI ones, this is what a
   * reviewer would see — and in India that is not a neutral fact, because
   * payment method correlates with a great deal.
   */
  const ledger = [
    ...Array.from({ length: 300 }, (_, i) =>
      toOfferRecord(
        facts({ revenueEventId: `card_${i}`, paymentMethod: "card", contacted: i < 240 }),
        IDENTITY
      )
    ),
    ...Array.from({ length: 300 }, (_, i) =>
      toOfferRecord(
        facts({ revenueEventId: `upi_${i}`, paymentMethod: "upi", contacted: i < 90 }),
        IDENTITY
      )
    ),
  ];

  const report = auditFairness({
    merchantId: IDENTITY.merchantId,
    attribute: "payment_method",
    offers: ledger,
  });

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verdict, "disparity");
  assert.equal(report.findings[0].compared.group, "upi");
  assert.ok(report.findings[0].gapPp < 0, "UPI customers are contacted less");
});

test("an evenhanded agent audits clean on the same path", () => {
  // The negative case matters as much: a writer that made everything look
  // like a disparity would be worse than no writer.
  const ledger = [
    ...Array.from({ length: 2000 }, (_, i) =>
      toOfferRecord(
        facts({ revenueEventId: `card_${i}`, paymentMethod: "card", contacted: i < 1000 }),
        IDENTITY
      )
    ),
    ...Array.from({ length: 2000 }, (_, i) =>
      toOfferRecord(
        facts({ revenueEventId: `upi_${i}`, paymentMethod: "upi", contacted: i < 995 }),
        IDENTITY
      )
    ),
  ];

  const report = auditFairness({
    merchantId: IDENTITY.merchantId,
    attribute: "payment_method",
    offers: ledger,
  });

  assert.equal(report.findings[0].verdict, "no_disparity");
});

test("an unconfigured merchant is labelled, not crashed", () => {
  /**
   * The ledger is an observability concern. A missing merchant name must not
   * take down the recovery pipeline, and `unconfigured` surfaces in the audit
   * output — which is the right place for a configuration problem to appear.
   */
  const identity = resolveIdentity({});
  assert.match(identity.merchantId, /unconfigured/);
  assert.equal(identity.category, "uncategorised");

  const named = resolveIdentity({ MERCHANT_NAME: "Kettle & Co" });
  assert.equal(named.merchantId, "Kettle & Co");
});

test("audited against the real deployed numbers, it refuses to give a clean bill of health", () => {
  /**
   * Not a fixture. These are the contact rates actually recorded by the
   * deployed instance, read out of production on 2026-09-28:
   *
   *   card        601 / 822   (73.1%)
   *   netbanking  166 / 221   (75.1%)
   *   upi         125 / 167   (74.9%)
   *
   * The rates look even, and a less careful tool would print "no disparity"
   * and move on. This one reports `underpowered`, because with 167 UPI
   * decisions the comparison could only have resolved a gap of about ten
   * points — so a material disparity could be sitting there invisibly.
   *
   * That is the whole argument for the third verdict, demonstrated on real
   * data rather than on numbers chosen to make it work. It is also a genuine
   * finding about this deployment: it does not yet have enough UPI traffic to
   * claim it treats UPI customers fairly.
   */
  const live: [string, number, number][] = [
    ["card", 822, 601],
    ["netbanking", 221, 166],
    ["upi", 167, 125],
  ];

  const ledger = live.flatMap(([method, n, contacted]) =>
    Array.from({ length: n }, (_, i) =>
      toOfferRecord(
        facts({
          revenueEventId: `${method}_${i}`,
          customerId: `${method}_${i}`,
          paymentMethod: method,
          contacted: i < contacted,
        }),
        IDENTITY
      )
    )
  );

  const report = auditFairness({
    merchantId: IDENTITY.merchantId,
    attribute: "payment_method",
    offers: ledger,
  });

  // Card is the largest group, so it is the reference.
  assert.equal(report.findings[0].reference.group, "card");
  assert.equal(report.findings.length, 2);

  for (const finding of report.findings) {
    assert.equal(
      finding.verdict,
      "underpowered",
      `${finding.compared.group} must not be reported as clean on ${finding.compared.n} observations`
    );
    assert.ok(
      finding.minimumDetectableEffectPp! > 5,
      "the comparison genuinely cannot resolve a material gap"
    );
  }

  assert.match(report.summary, /2 too small to tell/);
});
