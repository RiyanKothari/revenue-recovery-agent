import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketOutcomes, bucketForReason, type BucketId } from "../lib/outcome-buckets";

/**
 * The hero widget renders this partition, so its failure mode is a dashboard
 * that quietly misstates where the money went. The properties worth pinning
 * are that every event lands in exactly one bucket, that recovery outranks a
 * stopping reason, and that an unfamiliar reason is never silently promoted
 * into the "still open" pool.
 */

function sumEvents(buckets: { events: number }[]): number {
  return buckets.reduce((s, b) => s + b.events, 0);
}

function find(buckets: { id: BucketId; events: number; amountPaise: number }[], id: BucketId) {
  const bucket = buckets.find((b) => b.id === id);
  assert.ok(bucket, `expected a ${id} bucket`);
  return bucket;
}

test("every event lands in exactly one bucket", () => {
  const { buckets } = bucketOutcomes({
    events: [
      { id: "a", amount_paise: 10000 },
      { id: "b", amount_paise: 20000 },
      { id: "c", amount_paise: 30000 },
      { id: "d", amount_paise: 40000 },
      { id: "e", amount_paise: 50000 },
    ],
    recovered: [{ revenue_event_id: "a", recovered_amount_paise: 10000 }],
    stops: [
      { revenue_event_id: "b", reason: "customer_dnd_opt_out" },
      { revenue_event_id: "c", reason: "negative_expected_value" },
      { revenue_event_id: "d", reason: "holdout_control" },
    ],
  });

  assert.equal(sumEvents(buckets), 5);
  assert.equal(find(buckets, "recovered").events, 1);
  assert.equal(find(buckets, "held_back").events, 1);
  assert.equal(find(buckets, "not_worth_chasing").events, 1);
  assert.equal(find(buckets, "holdout").events, 1);
  assert.equal(find(buckets, "still_open").events, 1); // "e" — acted on, unresolved
});

test("amounts add up to the total when every recovery is full", () => {
  const { totalAtRiskPaise, buckets } = bucketOutcomes({
    events: [
      { id: "a", amount_paise: 10000 },
      { id: "b", amount_paise: 20000 },
    ],
    recovered: [{ revenue_event_id: "a", recovered_amount_paise: 10000 }],
    stops: [{ revenue_event_id: "b", reason: "cooldown_window_active" }],
  });

  assert.equal(totalAtRiskPaise, 30000);
  assert.equal(
    buckets.reduce((s, b) => s + b.amountPaise, 0),
    30000
  );
});

test("a recovered holdout control counts as recovered, not as holdout", () => {
  // The control arm is left alone, not prevented from paying. Money that came
  // back on its own is still money that came back, and filing it under the
  // measurement bucket would hide real recovery inside the experiment.
  const { buckets } = bucketOutcomes({
    events: [{ id: "a", amount_paise: 50000 }],
    recovered: [{ revenue_event_id: "a", recovered_amount_paise: 50000 }],
    stops: [{ revenue_event_id: "a", reason: "holdout_control" }],
  });

  assert.equal(find(buckets, "recovered").events, 1);
  assert.equal(find(buckets, "holdout").events, 0);
});

test("a partial recovery reports what came back, not what was at risk", () => {
  const { totalAtRiskPaise, buckets } = bucketOutcomes({
    events: [{ id: "a", amount_paise: 100000 }],
    recovered: [{ revenue_event_id: "a", recovered_amount_paise: 40000 }],
    stops: [],
  });

  assert.equal(totalAtRiskPaise, 100000);
  assert.equal(find(buckets, "recovered").amountPaise, 40000);
});

test("the first stopping reason decides, not the last", () => {
  // Later rows are consequences of the first stop, not competing causes.
  const { buckets } = bucketOutcomes({
    events: [{ id: "a", amount_paise: 10000 }],
    recovered: [],
    stops: [
      { revenue_event_id: "a", reason: "customer_dnd_opt_out" },
      { revenue_event_id: "a", reason: "negative_expected_value" },
    ],
  });

  assert.equal(find(buckets, "held_back").events, 1);
  assert.equal(find(buckets, "not_worth_chasing").events, 0);
});

test("a degraded safety check is held back, not counted as in-flight", () => {
  const { buckets } = bucketOutcomes({
    events: [{ id: "a", amount_paise: 10000 }],
    recovered: [],
    stops: [{ revenue_event_id: "a", reason: "guardrail_check_failed:consent" }],
  });

  assert.equal(find(buckets, "held_back").events, 1);
  assert.equal(find(buckets, "still_open").events, 0);
});

test("an unrecognised stopping reason is held back rather than shown as in-flight", () => {
  // A reason added later that this file has not been taught about still means
  // the event was not acted on. Defaulting it to "still open" would overstate
  // how much the agent is currently working.
  assert.equal(bucketForReason("some_future_stopping_rule"), "held_back");

  const { buckets } = bucketOutcomes({
    events: [{ id: "a", amount_paise: 10000 }],
    recovered: [],
    stops: [{ revenue_event_id: "a", reason: "some_future_stopping_rule" }],
  });

  assert.equal(find(buckets, "still_open").events, 0);
  assert.equal(find(buckets, "held_back").events, 1);
});

test("an empty batch produces zeroed buckets rather than throwing", () => {
  const { totalAtRiskPaise, buckets } = bucketOutcomes({
    events: [],
    recovered: [],
    stops: [],
  });

  assert.equal(totalAtRiskPaise, 0);
  assert.equal(buckets.length, 5);
  assert.equal(sumEvents(buckets), 0);
});

test("bucket order is fixed so the animated hero does not reshuffle", () => {
  const { buckets } = bucketOutcomes({ events: [], recovered: [], stops: [] });
  assert.deepEqual(
    buckets.map((b) => b.id),
    ["recovered", "still_open", "held_back", "not_worth_chasing", "holdout"]
  );
});
