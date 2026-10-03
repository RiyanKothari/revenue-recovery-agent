import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setDb, type RecoveryDb } from "../lib/db";
import { POST } from "../app/api/replay/route";
import { resetRateLimits } from "../lib/rate-limit";

/**
 * The Policy Lab replay route, end to end against a fake store.
 *
 * It reads every root cause's observed stats in one grouped query, and falls
 * back to the per-cause lookups the live pipeline uses if that read fails.
 * The grouped path was introduced purely for speed (3-6s of round trips per
 * replay in production), so the one thing it may not do is change the
 * answer. These run the same batch both ways and require the same response.
 */

const T0 = Date.parse("2026-06-01T10:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

// Two causes. Events e3 and e4 have NO assignment, so their recovery
// probability must come from the observed stats — the path under test.
const events = [
  { id: "e1", customer_id: "c1", amount_paise: 250_000, received_at: iso(0), root_cause: "bank_timeout" },
  { id: "e2", customer_id: "c2", amount_paise: 180_000, received_at: iso(10), root_cause: "bank_timeout" },
  { id: "e3", customer_id: "c3", amount_paise: 420_000, received_at: iso(20), root_cause: "card_declined" },
  { id: "e4", customer_id: "c4", amount_paise: 90_000, received_at: iso(30), root_cause: "bank_timeout" },
];
const decisions = [
  { id: "d1", revenue_event_id: "e1", chosen_action: "send_retry_link_whatsapp", rationale: "r", from_cache: false, cache_key: null },
  { id: "d2", revenue_event_id: "e2", chosen_action: "send_retry_link_whatsapp", rationale: "r", from_cache: false, cache_key: null },
];
const actions = [
  { agent_decision_id: "d1", channel: "whatsapp", status: "sent", attempt_number: 1, executed_at: iso(1) },
  { agent_decision_id: "d2", channel: "whatsapp", status: "sent", attempt_number: 1, executed_at: iso(11) },
];
const assignments = [
  { revenue_event_id: "e1", arm: "treated", recovery_probability: 0.4 },
  { revenue_event_id: "e2", arm: "treated", recovery_probability: 0.4 },
];
const outcomes = [
  { revenue_event_id: "e1", recovered: true, recovered_amount_paise: 250_000, resolved_at: iso(40) },
];

// What the store holds for each cause, answered identically by both paths.
const stats: Record<string, { trials: number; successes: number }> = {
  bank_timeout: { trials: 7, successes: 3 },
  card_declined: { trials: 4, successes: 1 },
};

interface Calls {
  grouped: number;
  perCause: number;
}

function fakeDb(groupedFails: boolean): { db: RecoveryDb; calls: Calls } {
  const calls: Calls = { grouped: 0, perCause: 0 };
  const impl: Record<string, (...args: any[]) => Promise<unknown>> = {
    async hitRateLimit() {
      return { count: 1, resetAt: iso(60) };
    },
    async countEvents() {
      return events.length;
    },
    async listEvents() {
      return events;
    },
    async listConsent() {
      return [];
    },
    async listDecisions() {
      return decisions;
    },
    async listRecoveryActions() {
      return actions;
    },
    async listAssignments() {
      return assignments;
    },
    async listOutcomes() {
      return outcomes;
    },
    async listStoppingRules() {
      return [];
    },
    async observedStatsByRootCause() {
      calls.grouped++;
      if (groupedFails) throw new Error("simulated grouped read failure");
      return Object.entries(stats).map(([root_cause, s]) => ({ root_cause, ...s }));
    },
    async countDecisionsByRootCause(cause: string) {
      calls.perCause++;
      return stats[cause]?.trials ?? 0;
    },
    async countRecoveredByRootCause(cause: string) {
      calls.perCause++;
      return stats[cause]?.successes ?? 0;
    },
  };
  // Anything else the route reaches for fails the test loudly, rather than
  // returning undefined and letting the comparison pass on two empty answers.
  const db = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === "string" && prop in target) return target[prop];
      if (prop === "then") return undefined;
      throw new Error(`replay route called an unexpected db method: ${String(prop)}`);
    },
  }) as unknown as RecoveryDb;
  return { db, calls };
}

async function replay(db: RecoveryDb, policy: Record<string, number> = {}) {
  // The route's in-process limiter allows twenty a minute, and the sweep
  // below makes ninety calls; the limiter has its own tests.
  resetRateLimits();
  setDb(db);
  const res = await POST(
    new Request("http://localhost/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Top-level fields, exactly as the Policy Lab page sends them. Nesting
      // them under "policy" is silently ignored and replays the defaults —
      // which is how this test first passed while testing nothing.
      body: JSON.stringify(policy),
    })
  );
  return { status: res.status, body: await res.json(), timing: res.headers.get("server-timing") };
}

afterEach(() => setDb(null));

test("the grouped stats and the per-cause fallback give the same replay", async () => {
  // Muted: the fallback logs the simulated failure, which is the point.
  const originalError = console.error;
  console.error = () => {};
  try {
    // The observed stats only reach the answer through the expected-value
    // gate, and only for an event whose threshold sits between the two
    // probabilities being compared. A handful of hand-picked thresholds missed
    // every such point — this test once passed with successes wiped to zero —
    // so the threshold is swept across the whole range of expected values.
    const policies: Record<string, number>[] = [
      {},
      { holdoutPercent: 5, cooldownMinutes: 480 },
      ...Array.from({ length: 43 }, (_, k) => ({ minExpectedValuePaise: k * 5_000 })),
    ];
    for (const policy of policies) {
      const fast = fakeDb(false);
      const slow = fakeDb(true);

      const a = await replay(fast.db, policy);
      const b = await replay(slow.db, policy);

      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, "a failed grouped read degrades, it does not fail the replay");
      assert.deepEqual(a.body, b.body, `same answer both ways for ${JSON.stringify(policy)}`);

      assert.equal(fast.calls.perCause, 0, "the grouped path makes no per-cause round trips");
      assert.ok(slow.calls.perCause > 0, "the fallback really did take the per-cause path");
    }
  } finally {
    console.error = originalError;
  }
});

test("the policy the request names is the policy that is replayed", async () => {
  const { body } = await replay(fakeDb(false).db, { minExpectedValuePaise: 75_000, holdoutPercent: 5 });

  assert.equal(body.candidate_policy.minExpectedValuePaise, 75_000);
  assert.equal(body.candidate_policy.holdoutPercent, 5);
});

test("the replay covers the whole batch and states it", async () => {
  const { body, status } = await replay(fakeDb(false).db);

  assert.equal(status, 200);
  assert.equal(body.events_replayed, events.length);
  assert.equal(body.scope.truncated, false);
  assert.match(body.scope.note, /whole recorded batch/);
});

test("every replay reports where its time went", async () => {
  const { timing } = await replay(fakeDb(false).db);

  assert.ok(timing, "Server-Timing header present");
  for (const phase of ["rate_limit", "count", "load", "observed_stats", "compute"]) {
    assert.match(timing!, new RegExp(`${phase};dur=\\d+`), `phase ${phase}`);
  }
});
