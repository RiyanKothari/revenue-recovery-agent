import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setDb, type RecoveryDb } from "../lib/db";
import { ATTRIBUTION_WINDOW_MINUTES, attributeRecovery } from "../lib/outcome-tracker";

/**
 * Attribution is what makes "amount recovered" a measurement rather than an
 * assertion, and it had no tests. Every assertion below is about one
 * question: given a failure and a later success on the same order, is the
 * success credited — and credited with the right time?
 */

const FAILED_AT = "2026-06-01T10:00:00.000Z";
const MINUTE = 60_000;

interface Recorded {
  outcomes: Array<Record<string, unknown>>;
  audits: Array<{ id: string; stage: string }>;
}

function fakeDb(params: {
  failure?: { id: string; received_at: string } | null;
  duplicate?: boolean;
}): { db: RecoveryDb; recorded: Recorded } {
  const recorded: Recorded = { outcomes: [], audits: [] };
  const impl: Record<string, unknown> = {
    async findLatestFailedEventByOrderId() {
      return params.failure === undefined
        ? { id: "evt_1", received_at: FAILED_AT }
        : params.failure;
    },
    async insertOutcome(row: Record<string, unknown>) {
      recorded.outcomes.push(row);
      return params.duplicate ? { duplicate: true as const } : { id: "out_1" };
    },
    async insertAudit(id: string, stage: string) {
      recorded.audits.push({ id, stage });
    },
  };
  // Anything the tracker reaches for beyond these three is a test failure,
  // not a silent undefined that happens to make the assertions pass.
  const db = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === "string" && prop in target) return target[prop];
      if (prop === "then") return undefined;
      throw new Error(`outcome-tracker called an unexpected db method: ${String(prop)}`);
    },
  }) as unknown as RecoveryDb;
  return { db, recorded };
}

const at = (minutesAfterFailure: number) =>
  new Date(Date.parse(FAILED_AT) + minutesAfterFailure * MINUTE).toISOString();

function recover(recoveredAtIso?: string) {
  return attributeRecovery({
    razorpayOrderId: "order_1",
    recoveredPaymentId: "pay_ok",
    recoveredAmountPaise: 249900,
    recoveredAtIso,
  });
}

afterEach(() => setDb(null));

test("a recovery inside the window is credited at the time it happened", async () => {
  const { db, recorded } = fakeDb({});
  setDb(db);

  await recover(at(20));

  assert.equal(recorded.outcomes.length, 1);
  const row = recorded.outcomes[0];
  assert.equal(row.revenue_event_id, "evt_1");
  assert.equal(row.recovered_amount_paise, 249900);
  assert.equal(row.resolved_at, at(20), "resolved_at is when it was paid, not when we noticed");
  assert.equal(row.attribution_window_minutes, ATTRIBUTION_WINDOW_MINUTES);
  assert.deepEqual(recorded.audits, [{ id: "evt_1", stage: "outcome_recorded" }]);
});

/**
 * The bug the window was rewritten to fix: measured against the clock, a
 * recovery twenty minutes after its failure was credited if processed at once
 * and discarded if processed two days later. FAILED_AT is months before any
 * plausible wall clock running this suite, so if the clock leaked back in,
 * this would fail.
 */
test("attribution depends on the gap between failure and recovery, not today's date", async () => {
  assert.ok(Date.now() - Date.parse(FAILED_AT) > ATTRIBUTION_WINDOW_MINUTES * MINUTE);
  const { db, recorded } = fakeDb({});
  setDb(db);

  await recover(at(20));

  assert.equal(recorded.outcomes.length, 1);
});

test("the window is exclusive at exactly its configured length", async () => {
  const inside = fakeDb({});
  setDb(inside.db);
  await recover(at(ATTRIBUTION_WINDOW_MINUTES - 1));
  assert.equal(inside.recorded.outcomes.length, 1, "one minute inside is credited");

  const edge = fakeDb({});
  setDb(edge.db);
  await recover(at(ATTRIBUTION_WINDOW_MINUTES));
  assert.equal(edge.recorded.outcomes.length, 0, "exactly the window length is not");
});

test("a recovery that predates its failure is refused, not recorded as negative", async () => {
  const { db, recorded } = fakeDb({});
  setDb(db);

  await recover(at(-5));

  assert.equal(recorded.outcomes.length, 0);
  assert.equal(recorded.audits.length, 0);
});

test("an unparseable recovery time is refused rather than guessed at", async () => {
  const { db, recorded } = fakeDb({});
  setDb(db);

  await recover("not a date");

  assert.equal(recorded.outcomes.length, 0);
});

test("a success with no matching failure is not this pipeline's recovery", async () => {
  const { db, recorded } = fakeDb({ failure: null });
  setDb(db);

  await recover(at(20));

  assert.equal(recorded.outcomes.length, 0);
  assert.equal(recorded.audits.length, 0);
});

test("a redelivered success is attributed once and audited once", async () => {
  // The data layer reports the unique-key collision as { duplicate: true };
  // the tracker must not log a second outcome_recorded for it.
  const { db, recorded } = fakeDb({ duplicate: true });
  setDb(db);

  await recover(at(20));

  assert.equal(recorded.outcomes.length, 1, "the insert was attempted");
  assert.equal(recorded.audits.length, 0, "but the duplicate is not audited again");
});
