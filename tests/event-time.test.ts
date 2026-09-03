import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEventTime } from "../lib/event-time";
import {
  syntheticCreatedAt,
  uniqueCustomerCount,
  customerIndexFor,
  simulatedRecoveryAt,
} from "../scripts/generate-synthetic-batch";

/**
 * `created_at` arrives inside a signed payload, which authenticates the
 * sender but says nothing about whether the value is sane. Every time-based
 * rule in the pipeline reads it, so a bad one is not a cosmetic problem: a
 * sufficiently old timestamp places an event outside its own cooldown window
 * and buys a second nudge the rule exists to prevent.
 */

const NOW = new Date("2026-09-03T12:00:00.000Z");

test("a plausible timestamp is used as the event time", () => {
  const twoHoursAgo = Math.floor(NOW.getTime() / 1000) - 7200;
  const result = resolveEventTime(twoHoursAgo, NOW);

  assert.equal(result.receivedAt, "2026-09-03T10:00:00.000Z");
  assert.equal(result.rejected, undefined);
});

test("an absent timestamp defers to the database default without complaint", () => {
  // Not every payload carries one, and that is not an error.
  for (const value of [undefined, null]) {
    const result = resolveEventTime(value, NOW);
    assert.equal(result.receivedAt, null);
    assert.equal(result.rejected, undefined);
  }
});

test("a far-past timestamp is refused — that is what backdating looks like", () => {
  // Old enough to fall outside any cooldown window, which is precisely the
  // point of forging it.
  const ancient = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
  const result = resolveEventTime(ancient, NOW);

  assert.equal(result.receivedAt, null);
  assert.match(result.rejected ?? "", /days old/);
});

test("a future timestamp is refused", () => {
  const tomorrow = Math.floor(NOW.getTime() / 1000) + 86400;
  const result = resolveEventTime(tomorrow, NOW);

  assert.equal(result.receivedAt, null);
  assert.match(result.rejected ?? "", /future/);
});

test("small clock skew is tolerated rather than refused", () => {
  // Refusing a two-minute skew would reject legitimate traffic from a server
  // whose clock runs slightly fast.
  const slightlyAhead = Math.floor(NOW.getTime() / 1000) + 120;
  assert.equal(resolveEventTime(slightlyAhead, NOW).receivedAt !== null, true);
});

test("junk values are refused without throwing", () => {
  for (const value of ["not-a-time", NaN, Infinity, -1, 0, {}, [], true]) {
    const result = resolveEventTime(value, NOW);
    assert.equal(result.receivedAt, null, `${JSON.stringify(value)} should be refused`);
    assert.ok(result.rejected, `${JSON.stringify(value)} should say why`);
  }
});

test("a numeric string is accepted — JSON payloads are not strictly typed", () => {
  const twoHoursAgo = String(Math.floor(NOW.getTime() / 1000) - 7200);
  assert.equal(resolveEventTime(twoHoursAgo, NOW).receivedAt, "2026-09-03T10:00:00.000Z");
});

// --- the synthetic batch's own spread ---------------------------------------

test("synthetic events span a real window rather than one moment", () => {
  const now = NOW.getTime();
  const size = 400;
  const times = Array.from({ length: size }, (_, i) => syntheticCreatedAt(i, size, now));

  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
  assert.ok(spanDays > 6.5 && spanDays < 7.5, `expected ~7 days, got ${spanDays}`);
});

test("first-time failures are ordered oldest first", () => {
  const now = NOW.getTime();
  const size = 400;
  const pool = uniqueCustomerCount(size);

  for (let i = 1; i < pool; i++) {
    assert.ok(
      syntheticCreatedAt(i, size, now) > syntheticCreatedAt(i - 1, size, now),
      `first-time event ${i} should be later than ${i - 1}`
    );
  }
});

test("a repeat failure follows its customer's first by hours, not days", () => {
  // Spreading every event evenly put repeat attempts a week apart, which
  // placed all of them outside any sane cooldown window — the guardrail
  // became unreachable in the opposite direction from the original bug.
  const now = NOW.getTime();
  const size = 400;
  const pool = uniqueCustomerCount(size);

  for (let i = pool; i < Math.min(size, pool + 40); i++) {
    const gapHours =
      (syntheticCreatedAt(i, size, now) - syntheticCreatedAt(customerIndexFor(i, size), size, now)) /
      3600;

    assert.ok(gapHours > 0 && gapHours < 24, `event ${i} gap was ${gapHours}h`);
  }
});

test("the batch contains repeats both inside and outside the cooldown window", () => {
  // A rule that always fires demonstrates itself no better than one that
  // never does, so the batch has to contain both.
  const now = NOW.getTime();
  const size = 400;
  const pool = uniqueCustomerCount(size);
  const cooldownHours = 4; // the default policy's 240 minutes

  let inside = 0;
  let outside = 0;

  for (let i = pool; i < size; i++) {
    const gapHours =
      (syntheticCreatedAt(i, size, now) - syntheticCreatedAt(customerIndexFor(i, size), size, now)) /
      3600;
    if (gapHours < cooldownHours) inside += 1;
    else outside += 1;
  }

  assert.ok(inside > 0, "no repeat lands inside the cooldown window");
  assert.ok(outside > 0, "no repeat lands outside the cooldown window");
});

test("every synthetic timestamp survives the pipeline's own validation", () => {
  // The generator must not produce values its own webhook would refuse.
  const now = NOW.getTime();
  for (let i = 0; i < 400; i += 37) {
    const result = resolveEventTime(syntheticCreatedAt(i, 400, now), NOW);
    assert.equal(result.rejected, undefined, `event ${i} was refused: ${result.rejected}`);
    assert.ok(result.receivedAt);
  }
});

test("a batch of one does not divide by zero", () => {
  const single = syntheticCreatedAt(0, 1, NOW.getTime());
  assert.ok(Number.isFinite(single));
  assert.equal(resolveEventTime(single, NOW).rejected, undefined);
});

// --- attribution timing -----------------------------------------------------

test("a simulated recovery lands after its failure and inside the window", () => {
  // Stamping recoveries "now" put every one of them days after its failure
  // and outside the 24h attribution window, which discarded most of them and
  // drove measured lift negative.
  const failedAt = "2026-08-28T09:00:00.000Z";

  for (const id of ["evt_a", "evt_b", "evt_c", "0f3c-91ab", "zzz"]) {
    const recoveredMs = simulatedRecoveryAt(id, failedAt) * 1000;
    const gapMinutes = (recoveredMs - new Date(failedAt).getTime()) / 60000;

    assert.ok(gapMinutes > 0, `${id} recovered before it failed`);
    assert.ok(gapMinutes < 24 * 60, `${id} fell outside the attribution window`);
  }
});

test("simulated recovery timing is deterministic across runs", () => {
  const failedAt = "2026-08-28T09:00:00.000Z";
  assert.equal(simulatedRecoveryAt("evt_x", failedAt), simulatedRecoveryAt("evt_x", failedAt));
});

test("different events recover at different speeds", () => {
  // A constant gap would make "average time to recovery" a single number
  // dressed up as a distribution.
  const failedAt = "2026-08-28T09:00:00.000Z";
  const gaps = new Set(
    ["a", "b", "c", "d", "e", "f"].map((id) => simulatedRecoveryAt(id, failedAt))
  );
  assert.ok(gaps.size > 1);
});
