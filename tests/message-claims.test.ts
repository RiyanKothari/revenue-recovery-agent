import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEADLINE_TOLERANCE_MS,
  adjudicateClaim,
  screenMessage,
  type Claim,
  type OfferFacts,
} from "../lib/message-claims";

/**
 * The Dark Pattern Sentinel.
 *
 * The test that matters most here is not that it catches a fabricated
 * deadline. It is that it lets an honest one through. A detector that flags
 * all urgency is trivially safe and commercially useless, and it would be
 * switched off within a week — so the pairs below deliberately send the SAME
 * sentence against two different configurations and assert that only the
 * unbacked one is held.
 */

const NOW = "2026-09-24T09:00:00.000Z";

function deadline(overrides: Partial<Extract<Claim, { type: "deadline" }>> = {}): Claim {
  return {
    type: "deadline",
    text: "This offer expires in 24 hours",
    hoursFromSend: 24,
    absoluteIso: null,
    ...overrides,
  };
}

/** 24h after NOW, so the default deadline claim is exactly true. */
const TRUE_EXPIRY = "2026-09-25T09:00:00.000Z";

// --- the pair the whole design rests on

test("the same urgency sentence passes when it is true and is held when it is not", () => {
  const honest = adjudicateClaim(deadline(), { offerExpiresAtIso: TRUE_EXPIRY }, NOW);
  assert.equal(honest.verdict, "supported");

  /**
   * Identical words, no expiry configured. This is the canonical dark
   * pattern and the reason a detector that scores copy for tone cannot work:
   * there is nothing manipulative about the sentence, only about the absence
   * behind it.
   */
  const fabricated = adjudicateClaim(deadline(), {}, NOW);
  assert.equal(fabricated.verdict, "unsupported");
  assert.match(fabricated.reason, /exists only in the message/);
});

test("a deadline brought forward manufactures urgency and says so", () => {
  // Real expiry is a month out; the message says tonight.
  const outcome = adjudicateClaim(
    deadline({ text: "Ends tonight", hoursFromSend: 12 }),
    { offerExpiresAtIso: "2026-10-24T09:00:00.000Z" },
    NOW
  );

  assert.equal(outcome.verdict, "contradicted");
  assert.match(outcome.reason, /manufactures urgency/);
});

test("a deadline promising more time than exists is also false, for a different reason", () => {
  /**
   * The mirror image, and it must not be waved through just because it is
   * generous. The customer finds out at the checkout, which is the worst
   * possible moment to discover a message lied.
   */
  const outcome = adjudicateClaim(
    deadline({ hoursFromSend: 72 }),
    { offerExpiresAtIso: TRUE_EXPIRY },
    NOW
  );

  assert.equal(outcome.verdict, "contradicted");
  assert.match(outcome.reason, /cannot honour/);
});

test("honest rounding is not manipulation", () => {
  /**
   * "Expires tomorrow" against an expiry half an hour either side of exactly
   * tomorrow is how people write, not a tactic. A screen that fires on this
   * cries wolf, and a detector nobody leaves running detects nothing.
   */
  const justInside = new Date(
    Date.parse(TRUE_EXPIRY) + DEADLINE_TOLERANCE_MS - 60_000
  ).toISOString();

  assert.equal(
    adjudicateClaim(deadline(), { offerExpiresAtIso: justInside }, NOW).verdict,
    "supported"
  );
});

test("an absolute deadline is resolved without the extractor doing date arithmetic", () => {
  // The model reports the shape of the claim; this module does the maths.
  const outcome = adjudicateClaim(
    deadline({ hoursFromSend: null, absoluteIso: TRUE_EXPIRY }),
    { offerExpiresAtIso: TRUE_EXPIRY },
    NOW
  );
  assert.equal(outcome.verdict, "supported");
});

test("a deadline that resolves to nothing is unverifiable, not fine", () => {
  const outcome = adjudicateClaim(
    deadline({ hoursFromSend: null, absoluteIso: null }),
    { offerExpiresAtIso: TRUE_EXPIRY },
    NOW
  );
  assert.equal(outcome.verdict, "unsupported");
});

// --- the other claim types

test("a discount is checked against the configured one, kind and value", () => {
  const facts: OfferFacts = { discount: { kind: "percent", value: 20 } };

  assert.equal(
    adjudicateClaim({ type: "discount", text: "20% off", kind: "percent", value: 20 }, facts, NOW)
      .verdict,
    "supported"
  );

  const overstated = adjudicateClaim(
    { type: "discount", text: "50% off", kind: "percent", value: 50 },
    facts,
    NOW
  );
  assert.equal(overstated.verdict, "contradicted");
  assert.match(overstated.reason, /50% off.*configured discount is 20%/);

  // A flat amount is not a percentage, even when the number matches.
  assert.equal(
    adjudicateClaim({ type: "discount", text: "₹20 off", kind: "flat", value: 20 }, facts, NOW)
      .verdict,
    "contradicted"
  );
});

test("understating stock manufactures a queue, overstating it is merely stale", () => {
  const facts: OfferFacts = { unitsRemaining: 500 };

  const fabricated = adjudicateClaim(
    { type: "scarcity", text: "Only 3 left", unitsRemaining: 3 },
    facts,
    NOW
  );
  assert.equal(fabricated.verdict, "contradicted");
  assert.match(fabricated.reason, /queue that does not exist/);

  /**
   * The asymmetry is deliberate. A message that has fallen behind fast-moving
   * stock has an accuracy problem, not a pressure tactic, and holding it
   * would fire hardest on exactly the merchants whose stock moves fastest.
   */
  assert.equal(
    adjudicateClaim(
      { type: "scarcity", text: "Only a few left", unitsRemaining: 900 },
      facts,
      NOW
    ).verdict,
    "supported"
  );
});

test("a personal offer that everyone gets is contradicted, however politely worded", () => {
  /**
   * The cleanest case in the set. Nothing about "a special price, just for
   * you" is aggressive. It is simply untrue, and only the record can say so.
   */
  const outcome = adjudicateClaim(
    { type: "exclusivity", text: "A special price, just for you" },
    { offerScope: "universal" },
    NOW
  );
  assert.equal(outcome.verdict, "contradicted");
  assert.match(outcome.reason, /available to everyone/);

  assert.equal(
    adjudicateClaim(
      { type: "exclusivity", text: "A special price, just for you" },
      { offerScope: "personalised" },
      NOW
    ).verdict,
    "supported"
  );
});

test("social proof may not exceed what is recorded", () => {
  const facts: OfferFacts = { recentPurchaseCount: 12 };

  assert.equal(
    adjudicateClaim(
      { type: "social_proof", text: "400 people bought this today", count: 400 },
      facts,
      NOW
    ).verdict,
    "contradicted"
  );

  assert.equal(
    adjudicateClaim(
      { type: "social_proof", text: "10 people bought this today", count: 10 },
      facts,
      NOW
    ).verdict,
    "supported"
  );
});

test("a was-price with no price history behind it is a fake anchor", () => {
  const outcome = adjudicateClaim(
    { type: "price_anchor", text: "Was ₹4,999", wasAmountPaise: 499900 },
    {},
    NOW
  );
  assert.equal(outcome.verdict, "unsupported");
  assert.match(outcome.reason, /no price history is recorded/);

  const wrong = adjudicateClaim(
    { type: "price_anchor", text: "Was ₹4,999", wasAmountPaise: 499900 },
    { previousPricePaise: 299900 },
    NOW
  );
  assert.equal(wrong.verdict, "contradicted");
  assert.match(wrong.reason, /₹2,999/);
});

test("every claim type refuses rather than passes when there is nothing to check it against", () => {
  /**
   * The property that makes the rule enforceable. If unverifiable claims
   * passed, every dark pattern would simply be one the system has no ground
   * truth for, and the detector would be grading itself on the subset it
   * already handles.
   */
  const claims: Claim[] = [
    deadline(),
    { type: "discount", text: "20% off", kind: "percent", value: 20 },
    { type: "scarcity", text: "Only 3 left", unitsRemaining: 3 },
    { type: "exclusivity", text: "Just for you" },
    { type: "social_proof", text: "400 bought today", count: 400 },
    { type: "price_anchor", text: "Was ₹4,999", wasAmountPaise: 499900 },
  ];

  for (const claim of claims) {
    assert.equal(
      adjudicateClaim(claim, {}, NOW).verdict,
      "unsupported",
      `${claim.type} must not pass against an empty record`
    );
  }
});

test("an explicit null is treated as no record, not as zero", () => {
  // `unitsRemaining: null` means "we do not know", and zero would mean
  // "sold out" — reading one as the other would make an unknown quantity
  // contradict every scarcity claim instead of failing to verify it.
  const outcome = adjudicateClaim(
    { type: "scarcity", text: "Only 3 left", unitsRemaining: 3 },
    { unitsRemaining: null },
    NOW
  );
  assert.equal(outcome.verdict, "unsupported");
});

// --- the whole message

test("a message with no factual claims sends", () => {
  /**
   * Not a loophole. "Your payment didn't go through, here's a link to try
   * again" asserts nothing about an offer, and holding it would block the
   * plainest and most honest message the system sends.
   */
  const result = screenMessage({ claims: [], facts: {}, nowIso: NOW });
  assert.equal(result.decision, "send");
  assert.match(result.summary, /No factual claims/);
});

test("a message sends only when every claim is backed", () => {
  const result = screenMessage({
    claims: [
      deadline(),
      { type: "discount", text: "20% off", kind: "percent", value: 20 },
    ],
    facts: { offerExpiresAtIso: TRUE_EXPIRY, discount: { kind: "percent", value: 20 } },
    nowIso: NOW,
  });

  assert.equal(result.decision, "send");
  assert.deepEqual(result.blocking, []);
  assert.match(result.summary, /All 2 claims are backed/);
});

test("one bad claim holds the whole message, and the reviewer sees which", () => {
  const result = screenMessage({
    claims: [
      { type: "discount", text: "20% off", kind: "percent", value: 20 },
      deadline({ text: "Ends tonight", hoursFromSend: 12 }),
    ],
    facts: {
      discount: { kind: "percent", value: 20 },
      offerExpiresAtIso: "2026-10-24T09:00:00.000Z",
    },
    nowIso: NOW,
  });

  assert.equal(result.decision, "hold");
  assert.equal(result.blocking.length, 1);
  // Traceable back to the words that caused it. A verdict a reviewer cannot
  // trace to a sentence is an accusation without evidence.
  assert.equal(result.blocking[0].claim.text, "Ends tonight");
  assert.equal(result.claims.length, 2, "the supported claim is still reported");
});

test("the summary separates what was contradicted from what could not be checked", () => {
  /**
   * The distinction the whole product turns on. "This is false" and "we have
   * nothing on record" are different findings, and a report that showed them
   * identically would be doing the thing this system exists to prevent.
   */
  const result = screenMessage({
    claims: [
      deadline({ text: "Ends tonight", hoursFromSend: 12 }),
      { type: "price_anchor", text: "Was ₹4,999", wasAmountPaise: 499900 },
    ],
    facts: { offerExpiresAtIso: "2026-10-24T09:00:00.000Z" },
    nowIso: NOW,
  });

  assert.equal(result.decision, "hold");
  assert.match(result.summary, /1 contradicted by the offer configuration/);
  assert.match(result.summary, /1 with nothing on record to support it/);
});
