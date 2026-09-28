import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isScreenable,
  resolveOffer,
  toOfferFacts,
  type MerchantOfferRow,
} from "../lib/offer-config";
import { screenMessage, type Claim } from "../lib/message-claims";

/**
 * The Sentinel's ground truth.
 *
 * The assertions that matter are about nulls surviving. A store that helpfully
 * substitutes a default turns "this merchant configured no expiry" into "this
 * offer expires at some plausible time", and the Sentinel's central case —
 * the fabricated deadline — silently starts passing while every test about
 * the adjudicator stays green.
 */

function row(overrides: Partial<MerchantOfferRow> = {}): MerchantOfferRow {
  return {
    offer_id: "SPRING20",
    merchant_id: "m_kettle",
    coupon_code: "SPRING20",
    discount_kind: "percent",
    discount_value: 20,
    valid_from: "2026-09-01T00:00:00.000Z",
    valid_until: "2026-09-30T00:00:00.000Z",
    scope: "personalised",
    units_remaining: null,
    previous_price_paise: null,
    recent_purchase_count: null,
    ...overrides,
  };
}

const NOW = "2026-09-15T12:00:00.000Z";

const deadlineClaim: Claim = {
  type: "deadline",
  text: "This offer expires in 24 hours",
  hoursFromSend: 24,
  absoluteIso: null,
};

// --- mapping

test("every null survives the mapping", () => {
  /**
   * The single most important property in this file. A default substituted
   * anywhere here would make an unbacked claim look backed.
   */
  const facts = toOfferFacts(
    row({
      valid_until: null,
      discount_kind: null,
      discount_value: null,
      scope: null,
      units_remaining: null,
      previous_price_paise: null,
      recent_purchase_count: null,
    })
  );

  assert.equal(facts.offerExpiresAtIso, null);
  assert.equal(facts.discount, null);
  assert.equal(facts.offerScope, null);
  assert.equal(facts.unitsRemaining, null);
  assert.equal(facts.previousPricePaise, null);
  assert.equal(facts.recentPurchaseCount, null);
});

test("a half-configured discount is no discount", () => {
  // A kind with no value, or a value with no kind, cannot adjudicate a claim
  // about either — and passing one through would compare against undefined.
  assert.equal(toOfferFacts(row({ discount_value: null })).discount, null);
  assert.equal(toOfferFacts(row({ discount_kind: null })).discount, null);
});

// --- status

test("a live offer is screenable", () => {
  const resolved = resolveOffer(row(), NOW);
  assert.equal(resolved.status, "active");
  assert.equal(isScreenable(resolved), true);
});

test("a missing offer yields no facts at all, not empty ones", () => {
  /**
   * Empty facts would send every claim through the adjudicator and come back
   * `unsupported` — the right decision by the wrong route, with a reason
   * blaming the merchant's configuration for an offer that was never found.
   */
  const resolved = resolveOffer(null, NOW);

  assert.equal(resolved.status, "missing");
  assert.equal(resolved.facts, null);
  assert.equal(isScreenable(resolved), false);
  assert.match(resolved.reason, /configuration problem rather than a finding about the copy/);
});

test("an offer that has ended is not accused of lying", () => {
  /**
   * The copy may have been accurate when it was written. Telling a marketer
   * their message is false when the real problem is that it is being sent
   * late sends them to fix the wrong thing.
   */
  const resolved = resolveOffer(row(), "2026-10-05T00:00:00.000Z");

  assert.equal(resolved.status, "ended");
  assert.equal(isScreenable(resolved), false);
  assert.match(resolved.reason, /may have been accurate when written/);
});

test("an offer that has not started yet is held too", () => {
  const resolved = resolveOffer(row(), "2026-08-01T00:00:00.000Z");
  assert.equal(resolved.status, "not_yet_started");
  assert.equal(isScreenable(resolved), false);
});

test("an offer with no window at all is live forever", () => {
  // Null bounds are not an error. A standing offer with no dates is a real
  // and common configuration; it simply cannot support a deadline claim.
  const resolved = resolveOffer(row({ valid_from: null, valid_until: null }), NOW);
  assert.equal(resolved.status, "active");
  assert.equal(isScreenable(resolved), true);
});

// --- end to end, store into adjudicator

test("the same deadline claim passes or holds on what the store actually says", () => {
  /**
   * The Sentinel's whole argument, now running on stored configuration rather
   * than a fixture. Only the row changes.
   */
  const expiringTomorrow = resolveOffer(
    row({ valid_until: "2026-09-16T12:00:00.000Z" }),
    NOW
  );
  const passed = screenMessage({
    claims: [deadlineClaim],
    facts: expiringTomorrow.facts!,
    nowIso: NOW,
  });
  assert.equal(passed.decision, "send");

  const noExpiry = resolveOffer(row({ valid_until: null }), NOW);
  const held = screenMessage({
    claims: [deadlineClaim],
    facts: noExpiry.facts!,
    nowIso: NOW,
  });
  assert.equal(held.decision, "hold");
  assert.equal(held.blocking[0].verdict, "unsupported");
  assert.match(held.blocking[0].reason, /exists only in the message/);
});

test("a universal coupon contradicts a personal offer, straight from the store", () => {
  const universal = resolveOffer(row({ scope: "universal" }), NOW);

  const result = screenMessage({
    claims: [{ type: "exclusivity", text: "A special price, just for you" }],
    facts: universal.facts!,
    nowIso: NOW,
  });

  assert.equal(result.decision, "hold");
  assert.equal(result.blocking[0].verdict, "contradicted");
  assert.match(result.blocking[0].reason, /available to everyone/);
});

test("a stored discount adjudicates a discount claim in both directions", () => {
  const facts = resolveOffer(row({ discount_kind: "percent", discount_value: 20 }), NOW).facts!;

  const honest = screenMessage({
    claims: [{ type: "discount", text: "20% off", kind: "percent", value: 20 }],
    facts,
    nowIso: NOW,
  });
  assert.equal(honest.decision, "send");

  const inflated = screenMessage({
    claims: [{ type: "discount", text: "50% off", kind: "percent", value: 50 }],
    facts,
    nowIso: NOW,
  });
  assert.equal(inflated.decision, "hold");
  assert.match(inflated.blocking[0].reason, /configured discount is 20%/);
});
