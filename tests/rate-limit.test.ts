import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceRateLimit,
  pruneRateLimits,
  rateLimit,
  resetRateLimits,
} from "../lib/rate-limit";

/**
 * Two counters, and the distinction is the whole point.
 *
 * The process window below is a fixed window in module memory: effective on a
 * long-lived server, and measured to do almost nothing on Vercel, where each
 * concurrent lambda gets its own copy. The shared counter tested further down
 * is what actually holds a limit across the fleet.
 */

test("requests are allowed up to the limit, then refused", () => {
  resetRateLimits();
  const t = 1_000_000;

  for (let i = 0; i < 5; i++) {
    assert.equal(rateLimit("k", 5, 60_000, t).allowed, true, `request ${i + 1} of 5`);
  }
  assert.equal(rateLimit("k", 5, 60_000, t).allowed, false, "the sixth is refused");
});

test("a refusal says when to come back", () => {
  // A bare 429 with no Retry-After makes well-behaved clients guess, and
  // guessing clients retry immediately — the exact traffic being shed.
  resetRateLimits();
  const t = 1_000_000;
  rateLimit("k", 1, 60_000, t);

  const refused = rateLimit("k", 1, 60_000, t + 10_000);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 60);
});

test("the window resets", () => {
  resetRateLimits();
  const t = 1_000_000;
  rateLimit("k", 1, 60_000, t);
  assert.equal(rateLimit("k", 1, 60_000, t + 1000).allowed, false);
  assert.equal(rateLimit("k", 1, 60_000, t + 60_001).allowed, true, "a new window opens");
});

test("keys are independent", () => {
  // Hammering the replay endpoint must not lock out the red team panel.
  resetRateLimits();
  const t = 1_000_000;
  rateLimit("replay", 1, 60_000, t);
  assert.equal(rateLimit("replay", 1, 60_000, t).allowed, false);
  assert.equal(rateLimit("redteam", 1, 60_000, t).allowed, true);
});

test("expired windows are pruned rather than leaked", () => {
  // A limiter that leaks memory to prevent resource abuse has become the
  // thing it was guarding against.
  resetRateLimits();
  const t = 1_000_000;
  for (let i = 0; i < 50; i++) rateLimit(`key_${i}`, 1, 1000, t);

  pruneRateLimits(t + 2000);

  // Every key is fresh again, which is only true if the entries were dropped.
  assert.equal(rateLimit("key_0", 1, 1000, t + 2000).allowed, true);
});

test("remaining never goes negative", () => {
  resetRateLimits();
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) rateLimit("k", 2, 60_000, t);
  assert.equal(rateLimit("k", 2, 60_000, t).remaining, 0);
});

/**
 * The shared counter — the part that actually holds on a platform that gives
 * every concurrent invocation its own module scope.
 *
 * The store is faked here so the behaviour can be asserted without a
 * database; that the SQL is atomic is asserted in the dual-driver contract
 * suite, which is the only place it can honestly be checked.
 */

/** A counter shared between callers, standing in for the table. */
function sharedStore() {
  const counts = new Map<string, { count: number; resetAt: number }>();
  return {
    counts,
    async hitRateLimit(bucket: string, windowMs: number, nowIso: string) {
      const now = Date.parse(nowIso);
      const existing = counts.get(bucket);
      if (!existing || now >= existing.resetAt) {
        counts.set(bucket, { count: 1, resetAt: now + windowMs });
      } else {
        existing.count += 1;
      }
      const current = counts.get(bucket)!;
      return { count: current.count, resetAt: new Date(current.resetAt).toISOString() };
    },
  };
}

test("the shared counter refuses a burst the process window would have let through", async () => {
  /**
   * The measurement this replaces: thirty-four requests against a limit of
   * thirty all returned 200 in production, because each landed on a different
   * lambda with its own Map. Simulated here by resetting the process window
   * between calls — which is exactly what a cold start does.
   */
  const store = sharedStore();
  const at = Date.parse("2026-09-05T10:00:00.000Z");
  const outcomes: boolean[] = [];

  for (let i = 0; i < 34; i++) {
    resetRateLimits(); // a fresh instance, every single request
    const result = await enforceRateLimit("burst", 30, 60_000, store, at + i);
    outcomes.push(result.allowed);
  }

  assert.equal(outcomes.filter(Boolean).length, 30, "exactly the limit is allowed");
  assert.equal(outcomes.slice(30).every((x) => x === false), true, "the rest are refused");
});

test("the process window still answers first, without a round trip", async () => {
  const store = sharedStore();
  const at = Date.parse("2026-09-05T10:00:00.000Z");

  resetRateLimits();
  for (let i = 0; i < 5; i++) {
    await enforceRateLimit("local", 3, 60_000, store, at + i);
  }

  // Two of the five never reached the store: the local window had already
  // refused them, which is the point of keeping it in front.
  assert.equal(store.counts.get("local")!.count, 3);
});

test("a refusal reports which counter refused it", async () => {
  const store = sharedStore();
  const at = Date.parse("2026-09-05T10:00:00.000Z");

  resetRateLimits();
  const first = await enforceRateLimit("scoped", 1, 60_000, store, at);
  assert.equal(first.scope, "shared");

  const second = await enforceRateLimit("scoped", 1, 60_000, store, at + 1);
  assert.equal(second.allowed, false);
  assert.equal(second.scope, "process", "the local window got there first");
});

test("an unavailable counter falls back rather than taking the endpoint down", async () => {
  /**
   * The one guard in this codebase that fails OPEN, deliberately. Everything
   * else refuses when it cannot evaluate itself, because refusing to act is
   * safer than acting wrongly. Nothing comparable is at stake here: these
   * endpoints are read-only and contact nobody, so failing closed would trade
   * a certain outage for a hypothetical load spike.
   */
  const broken = {
    async hitRateLimit() {
      throw new Error("counter table unreachable");
    },
  };

  resetRateLimits();
  const result = await enforceRateLimit("degraded", 5, 60_000, broken, Date.now());
  assert.equal(result.allowed, true);
  assert.equal(result.scope, "process", "the local window still applies");
});

test("with no store at all the process window is the whole limit", async () => {
  // getDb() throws without DATABASE_URL, and the red team suite must still
  // run in that state — half its value is showing what an outage looks like.
  resetRateLimits();
  const at = Date.now();
  assert.equal((await enforceRateLimit("nostore", 2, 60_000, null, at)).allowed, true);
  assert.equal((await enforceRateLimit("nostore", 2, 60_000, null, at + 1)).allowed, true);
  assert.equal((await enforceRateLimit("nostore", 2, 60_000, null, at + 2)).allowed, false);
});

test("the shared window resets on its own schedule", async () => {
  const store = sharedStore();
  const at = Date.parse("2026-09-05T10:00:00.000Z");

  resetRateLimits();
  await enforceRateLimit("reset", 1, 60_000, store, at);
  resetRateLimits();
  assert.equal((await enforceRateLimit("reset", 1, 60_000, store, at + 1000)).allowed, false);

  resetRateLimits();
  const after = await enforceRateLimit("reset", 1, 60_000, store, at + 61_000);
  assert.equal(after.allowed, true, "a new window starts once the old one expires");
});
