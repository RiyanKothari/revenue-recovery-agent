import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type DecisionDeps } from "../lib/decision-engine";
import type { Classification } from "../lib/classifier";

/**
 * Everything worth testing in the decision engine is a failure path. The
 * happy path is enforced by the JSON schema on the API side; what matters
 * here is that a refusal, a truncated response, or an action outside the
 * allowed set all degrade into human escalation instead of executing
 * something unintended — or crashing the webhook.
 */

const classification: Classification = {
  root_cause: "insufficient_funds",
  payment_method: "card",
  is_recoverable: true,
};

const input = {
  revenueEventId: "evt_1",
  classification,
  amountPaise: 50000,
  customerRetryHistory: [],
};

function harness(response: { text: string | null; stopReason: string }) {
  const audits: { stage: string; detail: Record<string, unknown> }[] = [];
  const inserted: Record<string, unknown>[] = [];

  const deps: Partial<DecisionDeps> = {
    model: { name: "fake", complete: async () => response } as any,
    db: {
      async insertDecision(row: Record<string, unknown>) {
        inserted.push(row);
        return { id: "dec_1" };
      },
    } as any,
    audit: (async (_id: string, stage: string, detail: Record<string, unknown>) => {
      audits.push({ stage, detail });
    }) as any,
  };

  return { deps, audits, inserted };
}

function jsonResponse(body: unknown, stopReason = "end_turn") {
  return { text: JSON.stringify(body), stopReason };
}

test("returns an in-bounds action as the agent chose it", async () => {
  const { deps, inserted } = harness(
    jsonResponse({
      action: "send_retry_link_whatsapp",
      rationale: "Insufficient funds, first attempt — a nudge is appropriate.",
    })
  );

  const result = await decide(input, deps);

  assert.equal(result.action, "send_retry_link_whatsapp");
  assert.equal(result.decisionId, "dec_1");
  assert.deepEqual(result.boundedBy, []);
  assert.equal(inserted[0].chosen_action, "send_retry_link_whatsapp");
  assert.equal(inserted[0].root_cause, "insufficient_funds");
});

test("escalates when the agent invents an action outside the allowed set", async () => {
  const { deps, audits } = harness(
    jsonResponse({ action: "issue_refund", rationale: "Just refund them." })
  );

  const result = await decide(input, deps);

  assert.equal(result.action, "escalate_human");
  assert.deepEqual(result.boundedBy, ["fixed_action_set"]);
  assert.ok(
    audits.some((a) => a.stage === "stopping_rule_triggered"),
    "an out-of-bounds action must be recorded as a stopping rule"
  );
});

test("escalates on a refusal", async () => {
  const { deps } = harness({ text: "", stopReason: "refusal" });

  const result = await decide(input, deps);

  assert.equal(result.action, "escalate_human");
  assert.deepEqual(result.boundedBy, ["fixed_action_set"]);
});

// The crash case. A max_tokens truncation returns a valid JSON *prefix*,
// which the previously unguarded JSON.parse threw on — taking down the
// webhook on the exact path meant to degrade into escalation.
test("escalates instead of throwing when the response is truncated mid-JSON", async () => {
  const { deps } = harness({
    text: '{"action":"send_retry_link_whatsapp","rationale":"The cus',
    stopReason: "max_tokens",
  });

  const result = await decide(input, deps);

  assert.equal(result.action, "escalate_human");
  assert.match(result.rationale, /max_tokens/);
});

test("escalates when the response is not JSON at all", async () => {
  const { deps } = harness({
    text: "I think we should send a WhatsApp message.",
    stopReason: "end_turn",
  });

  const result = await decide(input, deps);

  assert.equal(result.action, "escalate_human");
});

test("escalates when the rationale is missing", async () => {
  // The rationale is the explainability artifact — an action without one is
  // not a usable decision.
  const { deps } = harness(jsonResponse({ action: "send_retry_link_email" }));

  const result = await decide(input, deps);

  assert.equal(result.action, "escalate_human");
});

test("escalates when the model returns no text at all", async () => {
  const { deps } = harness({ text: null, stopReason: "end_turn" });

  const result = await decide(input, deps);

  assert.equal(result.action, "escalate_human");
});

test("always records the decision and an agent_decided audit entry", async () => {
  const { deps, audits, inserted } = harness(
    jsonResponse({
      action: "escalate_human",
      rationale: "Third attempt with no conversion — hand to a human.",
    })
  );

  await decide(input, deps);

  assert.equal(inserted.length, 1);
  const decided = audits.find((a) => a.stage === "agent_decided");
  assert.ok(decided, "every decision must reach the audit trail");
  assert.equal(decided?.detail.action, "escalate_human");
});
