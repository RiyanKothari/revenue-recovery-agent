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
