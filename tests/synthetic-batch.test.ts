import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateBatch,
  customerIndexFor,
  uniqueCustomerCount,
  isDndCustomer,
  DND_CUSTOMER_RATE,
} from "../scripts/generate-synthetic-batch";

/**
 * The batch is the evidence the whole submission rests on, so its shape is
 * worth asserting. The failure this guards against is subtle: a batch where
 * every event has a distinct customer looks fine, runs clean, and quietly
 * makes the cooldown and retry guardrails unreachable — so the demo proves
 * stopping rules that were never actually exercised.
 */

test("reuses customers so the cooldown guardrail is reachable", () => {
  const size = 800;
  const batch = generateBatch(size);

  const customers = batch.map(
    (e) => e.body.payload.payment.entity.customer_id
  );
  const distinct = new Set(customers);

  assert.ok(
    distinct.size < size,
    "every event had a unique customer — cooldown and retry ceiling can never fire"
  );

  // Enough repeats to be visible, not so many the batch is dominated by them.
  const repeatShare = 1 - distinct.size / size;
  assert.ok(
    repeatShare > 0.15 && repeatShare < 0.4,
    `repeat share ${(repeatShare * 100).toFixed(1)}% is outside the useful range`
  );
});

test("a repeat customer keeps the same contact number", () => {
  // Otherwise the cooldown looks up one identity and the send goes to another.
  const batch = generateBatch(400);
  const contactByCustomer = new Map<string, string>();

  for (const event of batch) {
    const entity = event.body.payload.payment.entity;
    const seen = contactByCustomer.get(entity.customer_id);
    if (seen) {
      assert.equal(entity.contact, seen, `contact drifted for ${entity.customer_id}`);
    } else {
      contactByCustomer.set(entity.customer_id, entity.contact);
    }
  }
});

test("customer assignment is deterministic across runs", () => {
  // A re-run has to reproduce the same batch, or the measured numbers move
  // for reasons unrelated to the agent.
  const a = generateBatch(200).map((e) => e.body.payload.payment.entity.customer_id);
  const b = generateBatch(200).map((e) => e.body.payload.payment.entity.customer_id);

  assert.deepEqual(a, b);
});

test("event ids stay unique even when customers repeat", () => {
  // Idempotency keys on the event id — collisions would silently drop events.
  const batch = generateBatch(800);
  const ids = batch.map((e) => e.eventId);

  assert.equal(new Set(ids).size, ids.length);
});

test("includes a deliberately non-recoverable slice", () => {
  // So the exceptions list is never empty, per the design intent.
  const batch = generateBatch(800);
  const fraudulent = batch.filter((e) =>
    /fraud/i.test(e.body.payload.payment.entity.error_description)
  );

  assert.ok(fraudulent.length > 0, "no non-recoverable events — exceptions list would be empty");
});

test("opts a usable minority of the customer pool out of contact", () => {
  const pool = uniqueCustomerCount(800);
  const optedOut = Array.from({ length: pool }, (_, i) => i).filter(isDndCustomer);

  const share = optedOut.length / pool;
  assert.ok(
    share > DND_CUSTOMER_RATE * 0.5 && share < DND_CUSTOMER_RATE * 2,
    `DND share ${(share * 100).toFixed(1)}% is off target`
  );
  assert.ok(optedOut.length > 5, "too few opted-out customers to exercise the consent rule");
});

test("customer index never escapes the pool", () => {
  const size = 500;
  const pool = uniqueCustomerCount(size);

  for (let i = 0; i < size; i++) {
    const idx = customerIndexFor(i, size);
    assert.ok(idx >= 0 && idx < pool, `index ${idx} outside pool of ${pool}`);
  }
});

test("handles a batch of one without dividing by zero", () => {
  assert.equal(uniqueCustomerCount(1), 1);
  assert.equal(customerIndexFor(0, 1), 0);
  assert.equal(generateBatch(1).length, 1);
});

test("amounts are positive and in paise", () => {
  const batch = generateBatch(300);
  for (const event of batch) {
    const amount = event.body.payload.payment.entity.amount;
    assert.ok(Number.isInteger(amount), "paise amounts must be integers");
    assert.ok(amount > 0);
  }
});

/**
 * A batch whose measured result changes without any code changing cannot be
 * used to check whether a code change moved it — which is most of what the
 * batch is for. One re-run had the lift cross zero and the dashboard report
 * the effect as not established, on the strength of a different draw alone.
 */
test("the same batch size produces byte-identical events on every run", () => {
  /**
   * Pinned to one instant, which is the property that actually holds and the
   * one worth asserting.
   *
   * This test used to call `generateBatch(120)` twice and compare the
   * results, and it failed about one run in three — the generator stamped
   * each event from its own `Date.now()` call, so any run that straddled a
   * second boundary produced two batches differing by one second in
   * `created_at`. It looked like flakiness in the test and was a real defect
   * in the generator: a batch stamped from many clocks is not a reproducible
   * fixture, whatever the docs say about it.
   */
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  assert.deepEqual(generateBatch(120, now), generateBatch(120, now));
});

test("a batch is stamped from ONE clock, not one per event", () => {
  // The defect above, asserted directly rather than through its symptom.
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  const events = generateBatch(40, now);

  // The oldest first-time failure sits exactly at the far edge of the window.
  const stamps = events.map((e) => e.body.payload.payment.entity.created_at);
  const oldest = Math.min(...stamps);
  const expectedOldest = Math.floor((now - 7 * 86_400_000) / 1000);

  assert.equal(
    oldest,
    expectedOldest,
    "the window is measured from the supplied instant, to the second"
  );
});

test("a later run shifts the window and changes nothing else", () => {
  /**
   * Timestamps are relative to when the batch is generated, on purpose — the
   * fixture is meant to look like the last seven days whenever it is seeded.
   * Everything that is NOT a timestamp has to be identical regardless, which
   * is what makes the measured numbers reproducible.
   */
  const t0 = Date.parse("2026-09-05T12:00:00.000Z");
  const strip = (now: number) =>
    generateBatch(80, now).map((e) => {
      const { created_at, ...rest } = e.body.payload.payment.entity;
      return { eventId: e.eventId, entity: rest };
    });

  assert.deepEqual(strip(t0), strip(t0 + 3 * 86_400_000));
});

test("failure reasons and amounts are stable, not just the customer pool", () => {
  const a = generateBatch(60).map((e) => {
    const entity = e.body.payload.payment.entity;
    return `${entity.error_code}|${entity.error_description}|${entity.amount}`;
  });
  const b = generateBatch(60).map((e) => {
    const entity = e.body.payload.payment.entity;
    return `${entity.error_code}|${entity.error_description}|${entity.amount}`;
  });
  assert.deepEqual(a, b);
});

test("different events still differ — determinism is not uniformity", () => {
  // A seed applied wrongly can make every event identical, which would be
  // reproducible and useless.
  const batch = generateBatch(200);
  const amounts = new Set(batch.map((e) => e.body.payload.payment.entity.amount));
  const reasons = new Set(batch.map((e) => e.body.payload.payment.entity.error_code));

  assert.ok(amounts.size > 50, `expected varied amounts, got ${amounts.size}`);
  assert.ok(reasons.size > 1, `expected varied failure reasons, got ${reasons.size}`);
});

test("the whole weighted distribution is still reachable", () => {
  // Seeding must not collapse the tail — the deliberately non-recoverable
  // fraud slice is 3% and the guardrail demo depends on it appearing.
  const descriptions = new Set(
    generateBatch(400).map((e) => e.body.payload.payment.entity.error_description)
  );
  assert.ok(
    [...descriptions].some((d) => /fraud/i.test(String(d))),
    "the non-recoverable slice never appeared"
  );
  assert.ok(descriptions.size >= 5, `expected most reasons to appear, got ${descriptions.size}`);
});
