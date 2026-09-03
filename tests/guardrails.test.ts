import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGuardrails, type GuardrailDb } from "../lib/guardrails";
import { DEFAULT_POLICY } from "../lib/policy";

/**
 * These are the rules that stop the agent messaging someone who asked not to
 * be messaged, so they are worth testing properly.
 *
 * The data layer is injected as domain operations rather than a query
 * builder, which means these tests describe behaviour ("the consent lookup
 * fails") instead of mimicking a particular database's client. That is also
 * what lets the same suite cover both the Postgres and MySQL backends: the
 * guardrails cannot tell which one they are talking to.
 */

const FAIL = Symbol("throws");

interface Behaviour {
  consent?: { dnd: boolean } | null | typeof FAIL;
  actionCount?: number | typeof FAIL;
  recentAction?: boolean | typeof FAIL;
  paymentId?: string | null | typeof FAIL;
  disputeFlag?: boolean | typeof FAIL;
}

/** Every operation succeeds and nothing blocks. */
function permissive(): Behaviour {
  return {
    consent: null,
    actionCount: 0,
    recentAction: false,
    paymentId: "pay_1",
    disputeFlag: false,
  };
}

function fakeDb(behaviour: Behaviour): GuardrailDb {
  const resolve = <T>(value: T | typeof FAIL, label: string): T => {
    if (value === FAIL) throw new Error(`simulated ${label} failure`);
    return value as T;
  };

  return {
    async getConsent() {
      return resolve(behaviour.consent ?? null, "consent");
    },
    async countActionsForEvent() {
      return resolve(behaviour.actionCount ?? 0, "attempt count");
    },
    async hasActionForCustomerSince() {
      return resolve(behaviour.recentAction ?? false, "cooldown");
    },
    async getEventPaymentId() {
      return resolve(behaviour.paymentId ?? null, "event lookup");
    },
    async hasDisputeFlag() {
      return resolve(behaviour.disputeFlag ?? false, "dispute check");
    },
  };
}

/** A fixed event time keeps the cooldown window deterministic across runs. */
const EVENT_TIME = "2026-09-03T12:00:00.000Z";

const check = (behaviour: Behaviour) =>
  checkGuardrails("cust_1", "evt_1", EVENT_TIME, fakeDb(behaviour));

test("allows an action when every check is clear", async () => {
  const result = await check(permissive());
  assert.equal(result.allowed, true);
});

test("blocks a customer who has opted out via DND", async () => {
  const result = await check({ ...permissive(), consent: { dnd: true } });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "customer_dnd_opt_out");
});

test("blocks once the retry ceiling for the event is reached", async () => {
  const result = await check({
    ...permissive(),
    actionCount: DEFAULT_POLICY.maxRetryAttempts,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_retry_attempts_reached");
});

test("blocks while the cooldown window is still active", async () => {
  const result = await check({ ...permissive(), recentAction: true });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "cooldown_window_active");
});

test("blocks an event flagged as refunded or disputed", async () => {
  const result = await check({ ...permissive(), disputeFlag: true });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "refund_or_dispute_flagged");
});

test("skips the dispute check when the event has no payment id", async () => {
  const result = await check({ ...permissive(), paymentId: null, disputeFlag: true });

  assert.equal(result.allowed, true);
});

// --- Fail-closed regression tests.
//
// The original implementation dropped the database error from each query. A
// failing consent lookup returned null, `consent?.dnd` was falsy, and the
// guardrail returned allowed — so an outage silently disabled every safety
// rule at once. Each case below must block.

test("blocks when the consent lookup fails rather than assuming consent", async () => {
  const result = await check({ ...permissive(), consent: FAIL });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:consent");
});

test("blocks when the attempt count query fails rather than assuming zero", async () => {
  const result = await check({ ...permissive(), actionCount: FAIL });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:attempt_count");
});

test("blocks when the cooldown query fails rather than assuming no recent nudge", async () => {
  const result = await check({ ...permissive(), recentAction: FAIL });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:cooldown");
});

test("blocks when the event row cannot be read", async () => {
  const result = await check({ ...permissive(), paymentId: FAIL });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:event_lookup");
});

test("blocks when the dispute check itself errors", async () => {
  const result = await check({ ...permissive(), disputeFlag: FAIL });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "refund_or_dispute_flagged");
});

test("a total database outage blocks instead of allowing everything", async () => {
  const result = await check({
    consent: FAIL,
    actionCount: FAIL,
    recentAction: FAIL,
    paymentId: FAIL,
    disputeFlag: FAIL,
  });

  assert.equal(result.allowed, false);
});

test("respects a policy with a different retry ceiling", async () => {
  // Policy is data, so the ceiling is not baked into the rule.
  const strict = { ...DEFAULT_POLICY, maxRetryAttempts: 1 };
  const result = await checkGuardrails(
    "cust_1",
    "evt_1",
    EVENT_TIME,
    fakeDb({ ...permissive(), actionCount: 1 }),
    strict
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_retry_attempts_reached");
});

/**
 * The cooldown asks a question about the customer's past, not about our
 * server's clock. Razorpay retries deliveries with backoff, so these differ.
 */
test("the cooldown window is measured from the event, not from now", async () => {
  const windows: { since: string; until: string }[] = [];

  const db = {
    ...fakeDb(permissive()),
    async hasActionForCustomerSince(_c: string, since: string, until: string) {
      windows.push({ since, until });
      return false;
    },
  };

  const eventTime = "2026-09-01T06:00:00.000Z"; // two days before "now"
  await checkGuardrails("cust_1", "evt_1", eventTime, db);

  assert.equal(windows.length, 1);
  // 240-minute default cooldown, measured backwards from the event.
  assert.equal(windows[0].since, "2026-09-01T02:00:00.000Z");
  assert.equal(windows[0].until, eventTime);
});

test("a send that happened after the event cannot block it", async () => {
  // The window is bounded at both ends. An open-ended "since" would let a
  // message sent later than the event count as prior contact — blocking an
  // event on something that had not happened when it arrived.
  let upperBound: string | undefined;

  const db = {
    ...fakeDb(permissive()),
    async hasActionForCustomerSince(_c: string, _s: string, until: string) {
      upperBound = until;
      return false;
    },
  };

  const eventTime = "2026-09-01T06:00:00.000Z";
  await checkGuardrails("cust_1", "evt_1", eventTime, db);

  assert.equal(upperBound, eventTime);
});

test("an unreadable event time refuses rather than guessing", async () => {
  const result = await checkGuardrails("cust_1", "evt_1", "not-a-date", fakeDb(permissive()));

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "guardrail_check_failed:event_time");
});
