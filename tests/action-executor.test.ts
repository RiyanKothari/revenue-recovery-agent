import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAction, type ExecutorDeps } from "../lib/action-executor";
import type { Decision } from "../lib/decision-engine";

/**
 * The executor is the only module that causes something to happen outside
 * this system — a Razorpay payment link, a WhatsApp message. Every dependency
 * is injected here so the tests assert on what WOULD be sent without sending
 * anything.
 */

interface Recorded {
  inserts: Record<string, unknown>[];
  audits: { stage: string; detail: Record<string, unknown> }[];
  linksCreated: number;
  whatsappSends: { toPhoneE164: string; paymentLinkUrl: string }[];
}

function harness(overrides: {
  insertError?: { message: string };
  createLink?: ExecutorDeps["createLink"];
  sendWhatsApp?: ExecutorDeps["sendWhatsApp"];
} = {}) {
  const recorded: Recorded = {
    inserts: [],
    audits: [],
    linksCreated: 0,
    whatsappSends: [],
  };

  const deps: Partial<ExecutorDeps> = {
    db: {
      from() {
        return {
          insert(row: Record<string, unknown>) {
            recorded.inserts.push(row);
            return Promise.resolve({ error: overrides.insertError ?? null });
          },
        };
      },
    } as any,
    createLink:
      overrides.createLink ??
      (async () => {
        recorded.linksCreated += 1;
        return { paymentLinkId: "plink_1", shortUrl: "https://rzp.io/l/real" } as any;
      }),
    sendWhatsApp:
      overrides.sendWhatsApp ??
      (async (p: any) => {
        recorded.whatsappSends.push(p);
        return { success: true, messageId: "wamid_1" };
      }),
    audit: (async (_id: string, stage: string, detail: Record<string, unknown>) => {
      recorded.audits.push({ stage, detail });
    }) as any,
  };

  return { recorded, deps };
}

const baseParams = {
  revenueEventId: "evt_1",
  agentDecisionId: "dec_1",
  amountPaise: 50000,
  currency: "INR",
  customerContact: "+919999999999",
  attemptNumber: 2,
};

function decision(action: Decision["action"]): Decision {
  return { action, rationale: "test", boundedBy: [], decisionId: "dec_1" };
}

test("escalation records a human handoff and sends nothing", async () => {
  const { recorded, deps } = harness();

  await executeAction(
    { ...baseParams, decision: decision("escalate_human") },
    deps
  );

  assert.equal(recorded.linksCreated, 0);
  assert.equal(recorded.whatsappSends.length, 0);
  assert.equal(recorded.inserts.length, 1);
  assert.equal(recorded.inserts[0].channel, "human_escalation");
  assert.equal(recorded.inserts[0].action_type, "escalated");
});

test("whatsapp action creates a link and sends the real short_url", async () => {
  const { recorded, deps } = harness();

  await executeAction(
    { ...baseParams, decision: decision("send_retry_link_whatsapp") },
    deps
  );

  assert.equal(recorded.linksCreated, 1);
  assert.equal(recorded.whatsappSends.length, 1);
  // Not a URL hand-assembled from the link id — that shipped dead links.
  assert.equal(recorded.whatsappSends[0].paymentLinkUrl, "https://rzp.io/l/real");
  assert.equal(recorded.inserts[0].status, "sent");
  assert.equal(recorded.inserts[0].razorpay_payment_link_id, "plink_1");
});

test("email action creates a link without a whatsapp send", async () => {
  const { recorded, deps } = harness();

  await executeAction(
    { ...baseParams, decision: decision("send_retry_link_email") },
    deps
  );

  assert.equal(recorded.linksCreated, 1);
  assert.equal(recorded.whatsappSends.length, 0);
  assert.equal(recorded.inserts[0].channel, "email");
});

test("carries the real attempt number through to the recorded row", async () => {
  const { recorded, deps } = harness();

  await executeAction(
    { ...baseParams, attemptNumber: 3, decision: decision("send_retry_link_whatsapp") },
    deps
  );

  // Previously hardcoded to 1, which made every row claim to be a first try
  // and left the retry ceiling reading nonsense.
  assert.equal(recorded.inserts[0].attempt_number, 3);
});

test("a refused whatsapp send is recorded as failed, not sent", async () => {
  const { recorded, deps } = harness({
    sendWhatsApp: (async () => ({
      success: false,
      error: "refused_synthetic_recipient",
    })) as any,
  });

  await executeAction(
    { ...baseParams, decision: decision("send_retry_link_whatsapp") },
    deps
  );

  assert.equal(recorded.inserts[0].status, "failed");
  const audit = recorded.audits.find((a) => a.stage === "action_executed");
  assert.equal(audit?.detail.delivery_success, false);
});

test("an MCP link failure is still recorded as a failed attempt", async () => {
  const { recorded, deps } = harness({
    createLink: (async () => {
      throw new Error("razorpay_mcp_unavailable");
    }) as any,
  });

  await executeAction(
    { ...baseParams, decision: decision("send_retry_link_whatsapp") },
    deps
  );

  // The attempt must still be counted, or the retry ceiling never advances
  // and a persistently failing gateway becomes an infinite retry loop.
  assert.equal(recorded.inserts.length, 1);
  assert.equal(recorded.inserts[0].status, "failed");
  assert.equal(recorded.whatsappSends.length, 0);
});

// --- The blind-counter case.
//
// guardrails.ts enforces the retry ceiling and cooldown by counting rows in
// recovery_actions. If the executor's insert fails silently, those counts
// never advance and the customer can be nudged forever. The write path must
// never quietly disable the read path's safety rules.

test("throws when the action cannot be recorded rather than continuing", async () => {
  const { recorded, deps } = harness({ insertError: { message: "db unavailable" } });

  await assert.rejects(
    executeAction(
      { ...baseParams, decision: decision("send_retry_link_whatsapp") },
      deps
    ),
    /Failed to record recovery action/
  );

  // And it must not retry the same failing insert from the catch block.
  assert.equal(recorded.inserts.length, 1);

  const warned = recorded.audits.find((a) =>
    String(a.detail.error ?? "").includes("action_not_recorded")
  );
  assert.ok(warned, "expected an audit entry flagging the unrecorded action");
});

test("throws when an escalation cannot be recorded", async () => {
  const { deps } = harness({ insertError: { message: "db unavailable" } });

  await assert.rejects(
    executeAction({ ...baseParams, decision: decision("escalate_human") }, deps),
    /Failed to record recovery action/
  );
});
