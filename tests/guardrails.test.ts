import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkGuardrails,
  MAX_RETRY_ATTEMPTS,
  type GuardrailDb,
} from "../lib/guardrails";

/**
 * These are the rules that stop the agent messaging someone who asked not to
 * be messaged, so they are worth testing properly. The Supabase client is
 * injected rather than mocked globally — each test queues the results its
 * queries should see, in call order.
 */

type QueryResult = { data?: any; error?: any; count?: number | null };

/**
 * checkGuardrails issues its queries in a fixed order:
 *   customer_consent → recovery_actions (count) → recovery_actions (cooldown)
 *   → revenue_events → audit_log
 * Two different queries hit recovery_actions, so results are queued per table
 * and consumed in order rather than keyed by table alone.
 */
function fakeDb(responses: Record<string, QueryResult[]>): GuardrailDb {
  const queues: Record<string, QueryResult[]> = {};
  for (const [table, results] of Object.entries(responses)) {
    queues[table] = [...results];
  }

  return {
    from(table: string) {
      const result = queues[table]?.shift() ?? { data: null, error: null };
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        limit: () => chain,
        contains: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        // Makes the chain awaitable for the queries that don't end in
        // single()/maybeSingle().
        then: (resolve: any) => resolve(result),
      };
      return chain;
    },
  } as unknown as GuardrailDb;
}

/** The all-clear: nothing blocks, so the agent is allowed to act. */
function permissiveResponses(): Record<string, QueryResult[]> {
  return {
    customer_consent: [{ data: null, error: null }],
    recovery_actions: [
      { count: 0, error: null },
      { data: [], error: null },
    ],
    revenue_events: [{ data: { razorpay_payment_id: "pay_1" }, error: null }],
    audit_log: [{ data: null, error: null }],
  };
}

test("allows an action when every check is clear", async () => {
  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(permissiveResponses()));

  assert.equal(result.allowed, true);
});

test("blocks a customer who has opted out via DND", async () => {
  const responses = permissiveResponses();
  responses.customer_consent = [{ data: { dnd: true }, error: null }];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "customer_dnd_opt_out");
});

test("blocks once the retry ceiling for the event is reached", async () => {
  const responses = permissiveResponses();
  responses.recovery_actions = [
    { count: MAX_RETRY_ATTEMPTS, error: null },
    { data: [], error: null },
  ];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_retry_attempts_reached");
});

test("blocks while the cooldown window is still active", async () => {
  const responses = permissiveResponses();
  responses.recovery_actions = [
    { count: 1, error: null },
    { data: [{ executed_at: new Date().toISOString() }], error: null },
  ];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "cooldown_window_active");
});

test("blocks an event flagged as refunded or disputed", async () => {
  const responses = permissiveResponses();
  responses.audit_log = [{ data: { id: "audit_1" }, error: null }];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "refund_or_dispute_flagged");
});

// --- Fail-closed regression tests.
//
// The original implementation destructured only `{ data }` and dropped
// `error`. A failing consent query returned data: null, `consent?.dnd` was
// falsy, and the guardrail returned allowed — so a database outage silently
// disabled every safety rule at once. Each case below must block.

test("blocks when the consent lookup fails rather than assuming consent", async () => {
  const responses = permissiveResponses();
  responses.customer_consent = [{ data: null, error: { message: "timeout" } }];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:consent");
});

test("blocks when the attempt count query fails rather than assuming zero", async () => {
  const responses = permissiveResponses();
  responses.recovery_actions = [
    { count: null, error: { message: "timeout" } },
    { data: [], error: null },
  ];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:attempt_count");
});

test("blocks when the attempt count is unavailable without an explicit error", async () => {
  const responses = permissiveResponses();
  responses.recovery_actions = [
    { count: null, error: null },
    { data: [], error: null },
  ];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:attempt_count_unavailable");
});

test("blocks when the cooldown query fails rather than assuming no recent nudge", async () => {
  const responses = permissiveResponses();
  responses.recovery_actions = [
    { count: 0, error: null },
    { data: null, error: { message: "timeout" } },
  ];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:cooldown");
});

test("blocks when the event row cannot be read", async () => {
  const responses = permissiveResponses();
  responses.revenue_events = [{ data: null, error: { message: "not found" } }];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:event_lookup");
});

test("blocks when the dispute check itself errors", async () => {
  const responses = permissiveResponses();
  responses.audit_log = [{ data: null, error: { message: "multiple rows" } }];

  const result = await checkGuardrails("cust_1", "evt_1", fakeDb(responses));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "refund_or_dispute_flagged");
});

test("a total database outage blocks instead of allowing everything", async () => {
  // Every query fails. The pre-fix implementation returned allowed: true here.
  const outage = fakeDb({});

  const result = await checkGuardrails("cust_1", "evt_1", outage);

  assert.equal(result.allowed, false);
});
