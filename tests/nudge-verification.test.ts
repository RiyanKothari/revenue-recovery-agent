import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_CAP,
  CODE_LENGTH,
  buildVerificationLine,
  consumesAttempt,
  decideVerification,
  deriveVerificationCode,
  formatCode,
  normaliseCode,
  parseClaimedAmount,
  type NudgeVerificationRecord,
} from "../lib/nudge-verification";

/**
 * Verified Nudge.
 *
 * The properties worth asserting here are not "does it say yes to the right
 * answer" — that one line would pass on a function that says yes to
 * everything. They are the ones an attacker probes: that a code cannot be
 * derived without the secret, that nothing except an exact match on a live
 * code returns `verified`, that guessing is capped, and that the caps cannot
 * be exhausted by input which never tested anything.
 */

const SECRET = "test-nudge-secret-not-a-real-one";
const EVENT = "11111111-2222-3333-4444-555555555555";

function record(overrides: Partial<NudgeVerificationRecord> = {}): NudgeVerificationRecord {
  return {
    code: "ABCD1234",
    revenueEventId: EVENT,
    merchantName: "Kettle & Co",
    amountPaise: 249900, // ₹2,499
    failedAtIso: "2026-09-20T08:32:00.000Z",
    expiresAtIso: "2026-09-23T08:32:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

const BEFORE_EXPIRY = "2026-09-21T10:00:00.000Z";
const AFTER_EXPIRY = "2026-09-25T10:00:00.000Z";

// --- deriving the code

test("the same event always derives the same code", () => {
  // The code in a sent message has to be re-derivable from the event rather
  // than stored as a second source of truth that can drift from it.
  assert.equal(deriveVerificationCode(EVENT, SECRET), deriveVerificationCode(EVENT, SECRET));
});

test("different events derive different codes", () => {
  const a = deriveVerificationCode(EVENT, SECRET);
  const b = deriveVerificationCode("99999999-8888-7777-6666-555555555555", SECRET);
  assert.notEqual(a, b);
});

test("the same event under a different secret derives a different code", () => {
  // If it did not, the secret would not be doing anything and the code would
  // be a pure function of a public event id.
  const a = deriveVerificationCode(EVENT, SECRET);
  const b = deriveVerificationCode(EVENT, "a-completely-different-secret");
  assert.notEqual(a, b);
});

test("a code is eight characters drawn only from the unambiguous alphabet", () => {
  // Read off a phone and typed back in. 1/I/L and 0/O are the same character
  // to a human eye, so none of the ambiguous ones may ever appear in output.
  for (let i = 0; i < 200; i++) {
    const code = deriveVerificationCode(`event-${i}`, SECRET);
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  }
});

test("an empty secret throws rather than deriving a code", () => {
  /**
   * The sharpest edge in this codebase, for the third time.
   * `createHmac("sha256", "")` does not throw — it signs with a key everyone
   * knows. Here that would make every verification code in the system
   * computable by a stranger holding an event id, which turns the
   * anti-phishing tool into a phishing tool.
   */
  assert.throws(() => deriveVerificationCode(EVENT, ""), /NUDGE_VERIFICATION_SECRET/);
  assert.throws(() => deriveVerificationCode(EVENT, "   "), /NUDGE_VERIFICATION_SECRET/);
  assert.throws(() => deriveVerificationCode(EVENT, undefined), /NUDGE_VERIFICATION_SECRET/);
});

test("codes spread across the alphabet rather than clustering", () => {
  // A derivation bug that reused the same bits would still be deterministic
  // and still look random in one sample. Counting distinct first characters
  // catches it.
  const firsts = new Set<string>();
  for (let i = 0; i < 500; i++) firsts.add(deriveVerificationCode(`e-${i}`, SECRET)[0]);
  assert.ok(firsts.size > 20, `expected wide spread, saw ${firsts.size} distinct first characters`);
});

// --- reading back what the customer typed

test("the code survives the ways a human retypes it", () => {
  const code = deriveVerificationCode(EVENT, SECRET);
  assert.equal(normaliseCode(formatCode(code)), code);
  assert.equal(normaliseCode(code.toLowerCase()), code);
  assert.equal(normaliseCode(` ${code.slice(0, 4)} ${code.slice(4)} `), code);
});

test("ambiguous characters are folded to the ones they look like", () => {
  assert.equal(normaliseCode("O1234567"), "01234567");
  assert.equal(normaliseCode("I2345678"), "12345678");
  assert.equal(normaliseCode("L2345678"), "12345678");
});

test("Q is a real code character and is never folded away", () => {
  /**
   * Regression. The first version mapped Q to 0 alongside O, which would have
   * silently corrupted roughly one code in eight — they would normalise to
   * something that is not in the database and every affected customer would
   * be told their genuine message was unrecognised.
   */
  assert.equal(normaliseCode("QQQQ1234"), "QQQQ1234");
});

test("input that cannot be a code is refused rather than coerced", () => {
  assert.equal(normaliseCode("ABC"), null, "too short");
  assert.equal(normaliseCode("ABCD12345"), null, "too long");
  assert.equal(normaliseCode("ABCDU234"), null, "U is not in the alphabet");
  assert.equal(normaliseCode(""), null);
  assert.equal(normaliseCode(null), null);
  assert.equal(normaliseCode(undefined), null);
});

// --- reading the amount

test("the amount is read the way it appears in a bank app", () => {
  assert.equal(parseClaimedAmount("2499"), 249900);
  assert.equal(parseClaimedAmount("2,499"), 249900);
  assert.equal(parseClaimedAmount("₹2,499.00"), 249900);
  assert.equal(parseClaimedAmount("Rs 2499"), 249900);
  assert.equal(parseClaimedAmount("INR2499"), 249900);
  assert.equal(parseClaimedAmount(" 2499 "), 249900);
});

test("paise are exact, not floating point", () => {
  /**
   * `24.99 * 100` is 2498.9999999999995. Rounding it silently would make the
   * comparison approximate, and a verification that is approximately right is
   * approximately worthless — it would tell some customers their genuine
   * message is fake.
   */
  assert.equal(parseClaimedAmount("24.99"), 2499);
  assert.equal(parseClaimedAmount("0.07"), 7);
  assert.equal(parseClaimedAmount("24.9"), 2490, "one decimal place means tenths of a rupee");
  assert.equal(parseClaimedAmount("1.10"), 110);
});

test("anything that is not an amount is null rather than a guess", () => {
  for (const input of ["", "abc", "-5", "0", "2499.999", "2 4 9 9x", "NaN", "1e3", "."]) {
    assert.equal(parseClaimedAmount(input), null, `expected null for ${JSON.stringify(input)}`);
  }
  assert.equal(parseClaimedAmount(null), null);
  assert.equal(parseClaimedAmount(undefined), null);
});

// --- the verdict

test("the right amount against a live code verifies, and says who by", () => {
  const outcome = decideVerification({
    record: record(),
    claimedAmountPaise: 249900,
    nowIso: BEFORE_EXPIRY,
  });

  assert.equal(outcome.status, "verified");
  if (outcome.status !== "verified") return;
  // The merchant name is released only here, after the customer has already
  // demonstrated they know the amount. It is never part of a refusal.
  assert.equal(outcome.merchantName, "Kettle & Co");
  assert.equal(outcome.amountPaise, 249900);
  assert.equal(outcome.revenueEventId, EVENT);
});

test("a wrong amount is refused and counts down the remaining attempts", () => {
  const outcome = decideVerification({
    record: record({ attempts: 1 }),
    claimedAmountPaise: 199900,
    nowIso: BEFORE_EXPIRY,
  });

  assert.equal(outcome.status, "mismatch");
  if (outcome.status !== "mismatch") return;
  assert.equal(outcome.attemptsRemaining, ATTEMPT_CAP - 2);
});

test("a code nobody issued reveals nothing", () => {
  // Also the useful answer: a customer typing the code from a phishing
  // message is told there is no such payment, which is what they came for.
  const outcome = decideVerification({
    record: null,
    claimedAmountPaise: 249900,
    nowIso: BEFORE_EXPIRY,
  });
  assert.deepEqual(outcome, { status: "unknown" });
});

test("a code stops answering once its attempts are spent", () => {
  // Including for the correct amount. Otherwise the cap is not a cap: an
  // attacker who exhausts it still learns the answer on the winning guess.
  const outcome = decideVerification({
    record: record({ attempts: ATTEMPT_CAP }),
    claimedAmountPaise: 249900,
    nowIso: BEFORE_EXPIRY,
  });
  assert.deepEqual(outcome, { status: "locked" });
});

test("an expired code refuses even the correct amount", () => {
  const outcome = decideVerification({
    record: record(),
    claimedAmountPaise: 249900,
    nowIso: AFTER_EXPIRY,
  });
  assert.deepEqual(outcome, { status: "expired" });
});

test("an unparseable amount never reaches the record", () => {
  /**
   * It returns `malformed` rather than `mismatch`, and the distinction is
   * load-bearing: a mismatch burns an attempt, so treating garbage as a
   * mismatch would let anyone exhaust a real customer's five tries with five
   * pieces of nonsense and lock them out of verifying their own message.
   */
  const outcome = decideVerification({
    record: record(),
    claimedAmountPaise: null,
    nowIso: BEFORE_EXPIRY,
  });
  assert.deepEqual(outcome, { status: "malformed" });
  assert.equal(consumesAttempt(outcome), false);
});

test("nothing but an exact match on a live code ever verifies", () => {
  /**
   * The single property the whole feature rests on. Near misses are the
   * realistic attack: an attacker who knows the rough size of a cart guesses
   * around it, and every one of these must refuse.
   */
  const near = [249899, 249901, 2499, 24990000, 250000, 249000, 0, -249900];

  for (const claimed of near) {
    const outcome = decideVerification({
      record: record(),
      claimedAmountPaise: claimed,
      nowIso: BEFORE_EXPIRY,
    });
    assert.notEqual(outcome.status, "verified", `${claimed} must not verify`);
  }

  // And no state of the record other than live-and-exact produces a verify.
  for (const r of [null, record({ attempts: ATTEMPT_CAP })]) {
    const outcome = decideVerification({
      record: r,
      claimedAmountPaise: 249900,
      nowIso: BEFORE_EXPIRY,
    });
    assert.notEqual(outcome.status, "verified");
  }
});

test("only a wrong amount against a live code spends an attempt", () => {
  // Stated once, here, so the route cannot quietly invent its own policy.
  assert.equal(consumesAttempt({ status: "mismatch", attemptsRemaining: 3 }), true);
  assert.equal(consumesAttempt({ status: "unknown" }), false);
  assert.equal(consumesAttempt({ status: "expired" }), false);
  assert.equal(consumesAttempt({ status: "locked" }), false);
  assert.equal(consumesAttempt({ status: "malformed" }), false);
  assert.equal(consumesAttempt({ status: "unavailable" }), false);
  assert.equal(
    consumesAttempt({
      status: "verified",
      merchantName: "x",
      amountPaise: 1,
      failedAtIso: BEFORE_EXPIRY,
      revenueEventId: EVENT,
    }),
    false,
    "a customer checking the same message twice is not an attack"
  );
});

test("a customer can use up their tries and the count never goes negative", () => {
  const outcome = decideVerification({
    record: record({ attempts: ATTEMPT_CAP - 1 }),
    claimedAmountPaise: 1,
    nowIso: BEFORE_EXPIRY,
  });
  assert.equal(outcome.status, "mismatch");
  if (outcome.status !== "mismatch") return;
  assert.equal(outcome.attemptsRemaining, 0);
});

// --- what the customer is told to do

test("the message line points at the check rather than asserting trust", () => {
  const code = deriveVerificationCode(EVENT, SECRET);
  const line = buildVerificationLine(code, "https://example.test/verify");

  assert.match(line, /Don't trust this message/);
  assert.ok(line.includes(formatCode(code)));
  assert.ok(line.includes("https://example.test/verify"));
  /**
   * A phishing message can also say "this message is genuine". It cannot
   * survive the check. So the copy must never contain a bare assurance, or it
   * trains exactly the reflex the attacker needs.
   */
  assert.doesNotMatch(line, /is genuine|is verified|official/i);
});
