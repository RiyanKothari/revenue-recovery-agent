import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionContextKey, decisionPrompt, amountBand } from "../lib/decision-cache";
import { decide, type DecisionDeps } from "../lib/decision-engine";
import type { Classification } from "../lib/classifier";

/**
 * The cache is only honest if two events sharing a key are genuinely
 * indistinguishable to the agent. That rests on one property: the key and the
 * prompt are derived from the same inputs. If the prompt ever carried
 * something the key does not, a cached rationale could describe a situation
 * that was not this event's — which would make the audit trail lie.
 */

const classification: Classification = {
  root_cause: "insufficient_funds",
  payment_method: "card",
  is_recoverable: true,
};

const ctx = (over: Partial<Parameters<typeof decisionContextKey>[0]> = {}) => ({
  classification,
  amountPaise: 129900,
  customerRetryHistory: [],
  ...over,
});

test("bands amounts coarsely enough to share decisions", () => {
  assert.equal(amountBand(40000), "under_500");
  assert.equal(amountBand(129900), "500_to_2000");
  assert.equal(amountBand(500000), "2000_to_10000");
  assert.equal(amountBand(4000000), "over_10000");
});

test("two events in the same band share a key", () => {
  // ₹1,299 and ₹1,850 are the same decision.
  assert.equal(
    decisionContextKey(ctx({ amountPaise: 129900 })),
    decisionContextKey(ctx({ amountPaise: 185000 }))
  );
});

test("events in different bands do not share a key", () => {
  // Chasing ₹200 and chasing ₹40,000 are different decisions.
  assert.notEqual(
    decisionContextKey(ctx({ amountPaise: 20000 })),
    decisionContextKey(ctx({ amountPaise: 4000000 }))
  );
});

test("root cause and payment method change the key", () => {
  const base = decisionContextKey(ctx());
  assert.notEqual(
    base,
    decisionContextKey(ctx({ classification: { ...classification, root_cause: "bank_timeout" } }))
  );
  assert.notEqual(
    base,
    decisionContextKey(ctx({ classification: { ...classification, payment_method: "upi" } }))
  );
});

test("retry history changes the key", () => {
  // "first attempt" and "third attempt, WhatsApp twice" must not share an answer.
  assert.notEqual(
    decisionContextKey(ctx()),
    decisionContextKey(
      ctx({
        customerRetryHistory: [
          { attempt_number: 1, channel: "whatsapp", status: "sent" },
          { attempt_number: 2, channel: "whatsapp", status: "sent" },
        ],
      })
    )
  );
});

test("the same attempts in a different order share a key", () => {
  // The agent needs to know what was tried, not the order rows came back in.
  const a = ctx({
    customerRetryHistory: [
      { attempt_number: 1, channel: "email", status: "sent" },
      { attempt_number: 2, channel: "whatsapp", status: "sent" },
    ],
  });
  const b = ctx({
    customerRetryHistory: [
      { attempt_number: 2, channel: "whatsapp", status: "sent" },
      { attempt_number: 1, channel: "email", status: "sent" },
    ],
  });
  assert.equal(decisionContextKey(a), decisionContextKey(b));
});

// The property the whole scheme depends on.
test("the prompt never contains anything absent from the key", () => {
  // Same key, different exact amounts — the prompts must be identical, or a
  // cached rationale could quote a figure belonging to another event.
  const p1 = decisionPrompt(ctx({ amountPaise: 129900 }));
  const p2 = decisionPrompt(ctx({ amountPaise: 185000 }));

  assert.equal(p1, p2);
  assert.ok(!p1.includes("1299"), "prompt must not carry the exact amount");
  assert.ok(!p1.includes("1850"), "prompt must not carry the exact amount");
  assert.match(p1, /between ₹500 and ₹2,000/);
});

// --- engine behaviour

function harness(opts: {
  cached?: { chosen_action: string; rationale: string; model: string } | null;
  response?: { text: string | null; stopReason: string };
}) {
  const inserted: any[] = [];
  const written: any[] = [];
  let modelCalls = 0;

  const deps: Partial<DecisionDeps> = {
    model: {
      name: "fake",
      complete: async () => {
        modelCalls += 1;
        return opts.response ?? { text: null, stopReason: "end_turn" };
      },
    } as any,
    db: {
      async getCachedDecision() {
        return opts.cached ?? null;
      },
      async putCachedDecision(row: any) {
        written.push(row);
      },
      async insertDecision(row: any) {
        inserted.push(row);
        return { id: "dec_1" };
      },
    } as any,
    audit: (async () => {}) as any,
  };

  return { deps, inserted, written, calls: () => modelCalls };
}

const input = {
  revenueEventId: "evt_1",
  classification,
  amountPaise: 129900,
  customerRetryHistory: [],
};

test("a cache hit skips the model entirely", async () => {
  const h = harness({
    cached: {
      chosen_action: "send_retry_link_whatsapp",
      rationale: "Reasoned earlier for this same situation.",
      model: "gemini:test",
    },
  });

  const result = await decide(input, h.deps);

  assert.equal(h.calls(), 0, "a cache hit must not call the model");
  assert.equal(result.action, "send_retry_link_whatsapp");
  assert.equal(h.inserted[0].from_cache, true);
  assert.ok(h.inserted[0].cache_key, "the decision must record which situation it answers");
});

test("a cache miss calls the model and memoises the answer", async () => {
  const h = harness({
    cached: null,
    response: {
      text: JSON.stringify({
        action: "send_retry_link_email",
        rationale: "Fresh reasoning.",
      }),
      stopReason: "end_turn",
    },
  });

  await decide(input, h.deps);

  assert.equal(h.calls(), 1);
  assert.equal(h.written.length, 1);
  assert.equal(h.written[0].chosen_action, "send_retry_link_email");
  assert.equal(h.inserted[0].from_cache, false);
});

// The important negative case.
test("a failed decision is never memoised", async () => {
  // Caching an escalation caused by a truncated response or a provider blip
  // would turn one transient failure into a permanent one for that entire
  // situation — every future event with the same key would escalate.
  const h = harness({
    cached: null,
    response: { text: '{"action":"send_retry_link_whatsapp","rat', stopReason: "max_tokens" },
  });

  const result = await decide(input, h.deps);

  assert.equal(result.action, "escalate_human");
  assert.equal(h.written.length, 0, "an escalation from a failure must not be cached");
});

test("a refusal is never memoised either", async () => {
  const h = harness({ cached: null, response: { text: "", stopReason: "refusal" } });

  await decide(input, h.deps);

  assert.equal(h.written.length, 0);
});

test("useCache false forces a fresh call even when a hit exists", async () => {
  const h = harness({
    cached: { chosen_action: "escalate_human", rationale: "old", model: "m" },
    response: {
      text: JSON.stringify({ action: "send_retry_link_email", rationale: "fresh" }),
      stopReason: "end_turn",
    },
  });

  const result = await decide(input, { ...h.deps, useCache: false });

  assert.equal(h.calls(), 1);
  assert.equal(result.rationale, "fresh");
});
