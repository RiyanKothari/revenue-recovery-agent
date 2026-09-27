import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClaims, screenOutboundMessage } from "../lib/claim-extractor";
import type { DecisionModel } from "../lib/decision-model";

/**
 * Extraction, and the one property that decides whether the Sentinel is a
 * safety control or decoration: a model that cannot answer must hold the
 * message, never pass it.
 */

function fakeModel(response: Partial<{ text: string | null; stopReason: string }>): DecisionModel {
  return {
    name: "fake",
    async complete() {
      return { text: null, stopReason: "end_turn", model: "fake-1", ...response };
    },
  };
}

function throwingModel(message: string): DecisionModel {
  return {
    name: "fake",
    async complete(): Promise<never> {
      throw new Error(message);
    },
  };
}

const VALID = JSON.stringify({
  claims: [
    { type: "deadline", text: "expires in 24 hours", hoursFromSend: 24, absoluteIso: null },
  ],
});

test("a well-formed extraction comes back typed", async () => {
  const result = await extractClaims("This offer expires in 24 hours", fakeModel({ text: VALID }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].type, "deadline");
  assert.equal(result.model, "fake-1");
});

test("a message with nothing to declare is distinguishable from a model that said nothing", async () => {
  /**
   * The trap this module exists to avoid. Both arrive as an absence, and
   * collapsing them fails open in the worst way: every message passes the
   * screen for as long as the model is unreachable, while the screen reports
   * a clean run.
   */
  const empty = await extractClaims("Your payment failed", fakeModel({ text: '{"claims":[]}' }));
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.claims, []);

  const silent = await extractClaims("Your payment failed", fakeModel({ text: null }));
  assert.equal(silent.ok, false);
});

test("every way the model can fail is a failure, not an empty list", async () => {
  const cases: [DecisionModel, RegExp][] = [
    [fakeModel({ stopReason: "refusal", text: VALID }), /refused/],
    // A prefix of a claim list is exactly the shape that passes a message by
    // omitting the claim that would have held it.
    [fakeModel({ stopReason: "max_tokens", text: '{"claims":[' }), /truncated/],
    [fakeModel({ text: "sorry, I can't help with that" }), /unparseable/],
    [throwingModel("ECONNRESET"), /unreachable/],
  ];

  for (const [model, expected] of cases) {
    const result = await extractClaims("anything", model);
    assert.equal(result.ok, false, `${expected} must not succeed`);
    if (!result.ok) assert.match(result.reason, expected);
  }
});

test("well-formed JSON of the wrong shape is refused before it reaches the adjudicator", async () => {
  /**
   * A model is perfectly capable of returning valid JSON describing a claim
   * type that does not exist. Unvalidated, that reaches the adjudicator as a
   * shape it has no branch for.
   */
  const invented = await extractClaims(
    "x",
    fakeModel({ text: JSON.stringify({ claims: [{ type: "guilt_trip", text: "come back" }] }) })
  );
  assert.equal(invented.ok, false);

  const malformed = await extractClaims(
    "x",
    // A deadline missing its nullable fields — indistinguishable from a
    // response truncated mid-object if the fields were merely optional.
    fakeModel({ text: JSON.stringify({ claims: [{ type: "deadline", text: "soon" }] }) })
  );
  assert.equal(malformed.ok, false);

  const notAList = await extractClaims("x", fakeModel({ text: '{"claims":"none"}' }));
  assert.equal(notAList.ok, false);
});

// --- the screen the send path calls

test("a screen that cannot run is a hold, and says which half refused", async () => {
  const result = await screenOutboundMessage({
    messageText: "Ends tonight!",
    facts: {},
    nowIso: "2026-09-24T09:00:00.000Z",
    model: throwingModel("ECONNRESET"),
  });

  assert.equal(result.decision, "hold");
  assert.equal(result.model, null, "no model answered, and the record says so");
  assert.match(result.summary, /could not be screened/);
  assert.match(result.summary, /not a screen that passed/);
});

test("extraction and adjudication compose into one verdict", async () => {
  // True deadline, backed by the configuration: it sends.
  const honest = await screenOutboundMessage({
    messageText: "This offer expires in 24 hours",
    facts: { offerExpiresAtIso: "2026-09-25T09:00:00.000Z" },
    nowIso: "2026-09-24T09:00:00.000Z",
    model: fakeModel({ text: VALID }),
  });
  assert.equal(honest.decision, "send");
  assert.equal(honest.model, "fake-1");

  // Same words, same extraction, no expiry on record: it holds.
  const fabricated = await screenOutboundMessage({
    messageText: "This offer expires in 24 hours",
    facts: {},
    nowIso: "2026-09-24T09:00:00.000Z",
    model: fakeModel({ text: VALID }),
  });
  assert.equal(fabricated.decision, "hold");
  assert.equal(fabricated.blocking.length, 1);
});
