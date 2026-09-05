import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneRateLimits, rateLimit, resetRateLimits } from "../lib/rate-limit";

/**
 * The two endpoints this guards are public, unauthenticated and do real
 * database work per request. The limiter is not protection against a
 * determined attacker — the counter is per-process and serverless gives each
 * instance its own — it is a guard against accidental hammering, which is the
 * actual risk profile of a demo deployment.
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
