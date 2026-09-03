import { test } from "node:test";
import assert from "node:assert/strict";
import {
  armSeries,
  causePerformance,
  dailySeries,
  MIN_EVENTS_FOR_RATE,
  type AnalyticsInput,
} from "../lib/analytics";

/**
 * These panels direct where effort goes, so the failure mode is a rate that
 * looks authoritative on a handful of observations.
 */

function input(overrides: Partial<AnalyticsInput> = {}): AnalyticsInput {
  return {
    events: [],
    recoveredIds: new Set(),
    armByEvent: new Map(),
    ...overrides,
  };
}

function ev(id: string, day: string, cause: string, amount = 100000) {
  return { id, amountPaise: amount, rootCause: cause, receivedAt: `${day}T10:00:00.000Z` };
}

test("days come back in chronological order", () => {
  // A time series that is not ordered by time is a bar chart with a
  // misleading x-axis.
  const series = dailySeries(
    input({
      events: [
        ev("c", "2026-09-03", "card_declined"),
        ev("a", "2026-09-01", "card_declined"),
        ev("b", "2026-09-02", "card_declined"),
      ],
    })
  );

  assert.deepEqual(series.map((d) => d.day), ["2026-09-01", "2026-09-02", "2026-09-03"]);
});

test("every event lands in exactly one day", () => {
  const events = Array.from({ length: 30 }, (_, i) =>
    ev(`e${i}`, `2026-09-0${(i % 3) + 1}`, "card_declined")
  );
  const series = dailySeries(input({ events }));
  assert.equal(series.reduce((s, d) => s + d.failures, 0), 30);
});

test("an unparseable timestamp is dropped, not bucketed to the epoch", () => {
  // Bucketing it would put a spike at 1970 and silently stretch the axis
  // across fifty-six years.
  const series = dailySeries(
    input({
      events: [
        ev("good", "2026-09-01", "card_declined"),
        { id: "bad", amountPaise: 1, rootCause: "x", receivedAt: "not-a-date" },
      ],
    })
  );

  assert.equal(series.length, 1);
  assert.equal(series[0].day, "2026-09-01");
});

test("a rate is withheld when the sample is too small to mean anything", () => {
  // One recovery from one attempt is not a 100% recovery rate, and a bar
  // drawn at full height will be read as one.
  const rows = causePerformance(
    input({
      events: [ev("a", "2026-09-01", "network_drop")],
      recoveredIds: new Set(["a"]),
    })
  );

  assert.equal(rows[0].sparse, true);
  assert.equal(rows[0].recoveryRate, null);
  assert.equal(rows[0].recovered, 1);
});

test("a rate is quoted once there are enough observations", () => {
  const events = Array.from({ length: MIN_EVENTS_FOR_RATE }, (_, i) =>
    ev(`e${i}`, "2026-09-01", "insufficient_funds")
  );
  const recoveredIds = new Set(events.slice(0, 5).map((e) => e.id));

  const rows = causePerformance(input({ events, recoveredIds }));

  assert.equal(rows[0].sparse, false);
  assert.ok(Math.abs(rows[0].recoveryRate! - 5 / MIN_EVENTS_FOR_RATE) < 1e-9);
});

test("causes are ranked by rupees recovered, not by rate", () => {
  // A 40% rate on eleven small failures matters less than a 22% rate on four
  // hundred large ones, and sorting by rate puts the wrong one on top of a
  // panel whose purpose is directing where effort goes.
  const small = Array.from({ length: 25 }, (_, i) => ev(`s${i}`, "2026-09-01", "network_drop", 1000));
  const large = Array.from({ length: 25 }, (_, i) => ev(`l${i}`, "2026-09-01", "card_declined", 900000));

  const rows = causePerformance(
    input({
      events: [...small, ...large],
      recoveredIds: new Set([
        ...small.slice(0, 20).map((e) => e.id), // 80% rate, tiny money
        ...large.slice(0, 6).map((e) => e.id), // 24% rate, large money
      ]),
    })
  );

  assert.equal(rows[0].cause, "card_declined");
});

test("an unclassified event is still counted", () => {
  const rows = causePerformance(
    input({ events: [{ id: "a", amountPaise: 1000, rootCause: null, receivedAt: "2026-09-01T00:00:00Z" }] })
  );
  assert.equal(rows[0].cause, "unclassified");
});

test("an arm with too few events that day breaks the line instead of plotting zero", () => {
  // A control arm with two events on Tuesday says nothing about Tuesday.
  // Drawing it at 0% would invent a collapse that never happened.
  const events = [
    ...Array.from({ length: 10 }, (_, i) => ev(`t${i}`, "2026-09-01", "card_declined")),
    ev("c1", "2026-09-01", "card_declined"),
    ev("c2", "2026-09-01", "card_declined"),
  ];
  const armByEvent = new Map(events.map((e) => [e.id, e.id.startsWith("c") ? "control" : "treated"]));

  const series = armSeries(input({ events, armByEvent, recoveredIds: new Set() }));

  assert.equal(series.length, 1);
  assert.equal(series[0].controlN, 2);
  assert.equal(series[0].controlRate, null, "too few control events to quote a rate");
  assert.notEqual(series[0].treatedRate, null, "ten treated events is enough");
});

test("events with no arm are excluded from the arm series", () => {
  // Blocked events never entered the experiment and must not dilute it.
  const events = [ev("a", "2026-09-01", "card_declined")];
  const series = armSeries(input({ events, armByEvent: new Map() }));
  assert.equal(series.length, 0);
});

test("empty input produces empty series rather than throwing", () => {
  assert.deepEqual(dailySeries(input()), []);
  assert.deepEqual(causePerformance(input()), []);
  assert.deepEqual(armSeries(input()), []);
});
