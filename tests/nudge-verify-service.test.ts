import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyNudge, type VerifierDb } from "../lib/nudge-verify-service";
import { ATTEMPT_CAP } from "../lib/nudge-verification";
import type { AttemptReservation, NudgeVerificationRow } from "../lib/db/types";

/**
 * The Verified Nudge check with the store attached.
 *
 * What matters here is not the verdict — that is asserted exhaustively
 * against the pure decider in nudge-verification.test.ts. It is the
 * bookkeeping around it: which inputs are allowed to cost a customer one of
 * their limited attempts, which are given back, and what happens when the
 * store cannot answer at all.
 */

const CODE = "ABCD1234";
const NOW = () => new Date("2026-09-21T10:00:00.000Z");

function row(overrides: Partial<NudgeVerificationRow> = {}): NudgeVerificationRow {
  return {
    code: CODE,
    revenue_event_id: "11111111-2222-3333-4444-555555555555",
    merchant_name: "Kettle & Co",
    amount_paise: 249900,
    failed_at: "2026-09-20T08:32:00.000Z",
    expires_at: "2026-09-23T08:32:00.000Z",
    attempts: 1, // post-increment: this is the first guess
    ...overrides,
  };
}

interface Spy {
  db: VerifierDb;
  reserved: { code: string; cap: number }[];
  refunded: string[];
}

function spy(
  reservation: AttemptReservation | (() => never),
  options: { refundThrows?: boolean } = {}
): Spy {
  const reserved: { code: string; cap: number }[] = [];
  const refunded: string[] = [];

  return {
    reserved,
    refunded,
    db: {
      async reserveVerificationAttempt(code: string, cap: number) {
        reserved.push({ code, cap });
        if (typeof reservation === "function") return reservation();
        return reservation;
      },
      async refundVerificationAttempt(code: string) {
        refunded.push(code);
        if (options.refundThrows) throw new Error("refund failed");
      },
    },
  };
}

test("the right amount verifies and the attempt is given back", () => {
  return (async () => {
    const s = spy({ row: row(), reserved: true });

    const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW });

    assert.equal(outcome.status, "verified");
    // A customer who checks the same message twice is not an attack.
    assert.deepEqual(s.refunded, [CODE]);
  })();
});

test("a wrong amount costs an attempt and it is not given back", async () => {
  const s = spy({ row: row({ attempts: 2 }), reserved: true });

  const outcome = await verifyNudge({ code: CODE, amount: "1899" }, { db: s.db, now: NOW });

  assert.equal(outcome.status, "mismatch");
  if (outcome.status !== "mismatch") return;
  // Two attempts used, so three of five remain.
  assert.equal(outcome.attemptsRemaining, ATTEMPT_CAP - 2);
  assert.deepEqual(s.refunded, []);
});

test("the count the customer is shown is the one at the time of their guess", async () => {
  /**
   * The reservation increments before the comparison, so handing the decider
   * the post-increment value would report one fewer try than is true and, on
   * the last one, lock someone out a guess early.
   */
  const s = spy({ row: row({ attempts: 1 }), reserved: true });

  const outcome = await verifyNudge({ code: CODE, amount: "1" }, { db: s.db, now: NOW });

  assert.equal(outcome.status, "mismatch");
  if (outcome.status !== "mismatch") return;
  assert.equal(outcome.attemptsRemaining, ATTEMPT_CAP - 1);
});

test("an unparseable amount never reaches the store", async () => {
  /**
   * An attempt belongs to the customer. Reserving one for input that tested
   * nothing would let a stranger exhaust a real person's five tries with five
   * pieces of nonsense and lock them out of checking their own message.
   */
  const s = spy({ row: row(), reserved: true });

  const outcome = await verifyNudge({ code: CODE, amount: "not a number" }, { db: s.db, now: NOW });

  assert.deepEqual(outcome, { status: "malformed" });
  assert.deepEqual(s.reserved, [], "nothing was reserved");
});

test("a string that cannot be a code is answered without a round trip", async () => {
  const s = spy({ row: row(), reserved: true });

  const outcome = await verifyNudge({ code: "nope", amount: "2499" }, { db: s.db, now: NOW });

  // Identical to a code nobody issued, because that is what it is — and no
  // distinction for an attacker to measure.
  assert.deepEqual(outcome, { status: "unknown" });
  assert.deepEqual(s.reserved, []);
});

test("a code nobody issued is unknown", async () => {
  const s = spy(null);
  const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW });
  assert.deepEqual(outcome, { status: "unknown" });
});

test("a code whose attempts are spent stops answering, right amount or not", async () => {
  const s = spy({ row: row({ attempts: ATTEMPT_CAP }), reserved: false });

  const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW });

  assert.deepEqual(outcome, { status: "locked" });
  // Nothing was taken, so there is nothing to give back.
  assert.deepEqual(s.refunded, []);
});

test("an expired code refuses and the attempt is returned", async () => {
  // Expiry tested nothing about the amount, so it must not cost a try.
  const s = spy({ row: row({ expires_at: "2026-09-20T09:00:00.000Z" }), reserved: true });

  const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW });

  assert.deepEqual(outcome, { status: "expired" });
  assert.deepEqual(s.refunded, [CODE]);
});

test("a store that cannot answer says so rather than guessing", async () => {
  /**
   * The whole feature in one assertion. This is the opposite polarity to the
   * rate limiter next to it in the same route, which fails open because the
   * harm it prevents is a large query. Here, answering `verified` when the
   * check did not happen tells someone a phishing message is genuine.
   */
  const s = spy(() => {
    throw new Error("connection terminated unexpectedly");
  });

  const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW });

  assert.deepEqual(outcome, { status: "unavailable" });
});

test("no database at all is unavailable, not unknown", async () => {
  // `unknown` would be a positive claim that no such payment exists, made by
  // a system that did not look.
  const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: null, now: NOW });
  assert.deepEqual(outcome, { status: "unavailable" });
});

test("a failed refund does not turn a successful check into an error", async () => {
  // The customer losing one try is a far smaller harm than an exception
  // replacing a correct verification with an error page.
  const s = spy({ row: row(), reserved: true }, { refundThrows: true });

  const outcome = await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW });

  assert.equal(outcome.status, "verified");
});

test("the cap the store enforces is the cap the decider uses", async () => {
  // Two different caps would mean the gate and the arithmetic disagree, and
  // the customer would be locked out at a number the page never showed them.
  const s = spy({ row: row(), reserved: true });
  await verifyNudge({ code: CODE, amount: "2499" }, { db: s.db, now: NOW, attemptCap: 3 });
  assert.deepEqual(s.reserved, [{ code: CODE, cap: 3 }]);
});

test("the customer's typing is normalised before it is looked up", async () => {
  const s = spy({ row: row(), reserved: true });

  // Lowercase, hyphenated, and with the O they typed for a 0.
  await verifyNudge({ code: "abcd-1234", amount: "₹2,499.00" }, { db: s.db, now: NOW });

  assert.equal(s.reserved[0].code, CODE);
});
