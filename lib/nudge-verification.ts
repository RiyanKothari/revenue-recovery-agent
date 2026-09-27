import crypto from "crypto";

/**
 * Verified Nudge — the customer-side half of a recovery message.
 *
 * ## The problem this exists for
 *
 * Automated failed-payment recovery, done at scale by anyone, makes "your
 * payment failed, tap here to pay" an ordinary message for millions of
 * people. That is precisely the template a phisher wants, and the recovery
 * industry is the thing that made it unremarkable.
 *
 * Every defence normally offered is merchant-side. Verify the webhook
 * signature; check the sender id; tell customers to "look for the official
 * domain". None of it helps the person holding the phone, because **a
 * genuine-looking payment link proves nothing**. Anyone can open a payment
 * gateway account and generate real links on a real gateway domain. Brand,
 * domain and link shape are all copyable, so none of them can authenticate a
 * recovery message.
 *
 * ## The insight
 *
 * What a scammer cannot copy is the *event*. They do not know that this
 * specific person failed this specific amount at this specific minute with
 * this specific merchant. So authentication is anchored in the shared payment
 * event rather than in a brand: the message carries a code, and the code is
 * bound to one genuine failed payment.
 *
 * ## Why it is a challenge and not a lookup
 *
 * The obvious design — type the code, see the payment details — is a
 * disaster. It turns this into an oracle: a scammer who guesses or harvests
 * codes learns who has failed payments, for how much, and when, which is
 * exactly the material that makes the *next* phishing message convincing.
 *
 * So the customer supplies the fact and the system only ever confirms or
 * denies it. You tell it what you tried to pay; it says whether that matches
 * a real failure. Someone who already knows the answer learns nothing new,
 * and someone who does not cannot extract it.
 *
 * Three things follow from that, and they are the whole security argument:
 *
 * 1. **Attempts against a real code are capped**, or the challenge degrades
 *    into a guessing game over a small space of plausible amounts.
 * 2. **Codes are unguessable**, or an attacker enumerates them and probes
 *    each one up to the cap. 40 bits over an alphabet with no ambiguous
 *    characters, on top of the shared per-caller rate limiter.
 * 3. **It fails closed.** A database blip must return `unavailable`, never
 *    `verified`. This is the opposite polarity to `lib/rate-limit.ts`, which
 *    documents why it is the one exception: there, failing open costs a
 *    large query. Here, failing open tells someone a phishing message is
 *    genuine.
 *
 * Nothing in this module reads the clock or touches the database. The record
 * and `now` are both passed in, for the reason written on
 * `ExecutorDeps.resolveWindow`: a test that reads the clock is a test whose
 * result depends on when you run it.
 */

/**
 * Crockford base32: no I, L, O or U.
 *
 * The first three are excluded because a code is read off a phone screen and
 * typed back in, where 1/I/L and 0/O are the same character to a human. U is
 * excluded because with the other 31 it is what keeps a randomly generated
 * code from occasionally spelling something the customer has to read aloud to
 * a support agent.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 8 characters over a 32-symbol alphabet: 40 bits. */
export const CODE_LENGTH = 8;

/**
 * How many wrong amounts one code tolerates before it stops answering.
 *
 * Five, because the real customer is reading the figure off their own bank
 * app and the common honest error is rupees-versus-paise or a forgotten
 * convenience fee, while an attacker guessing plausible cart values needs far
 * more than five tries to cover the space.
 */
export const ATTEMPT_CAP = 5;

/**
 * Codes stop answering after three days.
 *
 * Long enough that a customer who ignored the message over a weekend can
 * still check it, short enough that a harvested code is not a permanent
 * oracle about someone's payment history.
 */
export const VERIFICATION_TTL_MS = 72 * 60 * 60 * 1000;

export interface NudgeVerificationRecord {
  code: string;
  revenueEventId: string;
  /** Shown only on a successful match, never before it. */
  merchantName: string;
  amountPaise: number;
  failedAtIso: string;
  expiresAtIso: string;
  /** Wrong amounts supplied against this code so far. */
  attempts: number;
}

export type VerificationOutcome =
  | {
      status: "verified";
      merchantName: string;
      amountPaise: number;
      failedAtIso: string;
      revenueEventId: string;
    }
  | { status: "mismatch"; attemptsRemaining: number }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "locked" }
  | { status: "malformed" }
  | { status: "unavailable" };

/**
 * Derives the code for one failed payment.
 *
 * Deterministic, so the code in a message can be re-derived from the event
 * rather than being a second source of truth that can drift from it. Keyed,
 * so it cannot be computed by anyone who can see an event id.
 *
 * **An empty secret is a refusal, not a key.** `createHmac("sha256", "")`
 * does not throw; it computes a perfectly valid HMAC with a key everyone
 * knows. That exact trap has already cost this codebase two incidents — the
 * Razorpay webhook verifier and the Meta delivery callback both check for it
 * — and it is worse here, because the consequence is not a rejected webhook
 * but every code in the system being derivable by a stranger, which turns the
 * anti-phishing tool into a phishing tool.
 *
 * Throws rather than returning null: there is no sensible degraded mode for
 * "issue an unauthenticated authentication code".
 */
export function deriveVerificationCode(revenueEventId: string, secret: string | undefined): string {
  if (!secret || !secret.trim()) {
    throw new Error(
      "NUDGE_VERIFICATION_SECRET is not set. Refusing to derive a verification code: an empty HMAC key would make every code in the system computable by anyone holding an event id."
    );
  }

  if (!revenueEventId) {
    throw new Error("Cannot derive a verification code without a revenue event id.");
  }

  // Domain-separated, so this HMAC can never collide with another use of the
  // same secret if one is ever added.
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`nudge-verify:v1:${revenueEventId}`)
    .digest();

  let code = "";
  // 5 bits per character, read straight out of the digest. Five bytes cover
  // the eight characters exactly, so no bits are reused.
  for (let i = 0; i < CODE_LENGTH; i++) {
    const bitOffset = i * 5;
    const byteIndex = bitOffset >> 3;
    const window = (digest[byteIndex] << 8) | digest[byteIndex + 1];
    const shift = 11 - (bitOffset & 7);
    code += ALPHABET[(window >> shift) & 31];
  }

  return code;
}

/** `ABCD-EFGH`. Grouped because eight unbroken characters are misread. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What the customer typed, turned back into a code, or null if it cannot be.
 *
 * Forgiving in exactly the ways a human is wrong and strict everywhere else:
 * case, spaces and hyphens are theirs to get wrong, and the characters the
 * alphabet deliberately excludes are mapped to the ones they look like. A
 * customer who types O for 0 has not made a mistake worth failing them for;
 * the alphabet excluded the ambiguous character precisely so this mapping is
 * unambiguous in return.
 */
export function normaliseCode(input: string | null | undefined): string | null {
  if (!input) return null;

  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    // Only the characters the alphabet deliberately excludes are remapped.
    // Q and U are NOT in this list: Q is a perfectly valid code character, so
    // folding it into 0 would corrupt one code in eight, and U is excluded
    // from the alphabet without a visual twin to fold it into, so it is
    // simply invalid.
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

  if (cleaned.length !== CODE_LENGTH) return null;
  for (const char of cleaned) {
    if (!ALPHABET.includes(char)) return null;
  }

  return cleaned;
}

/**
 * The amount the customer says they tried to pay, in paise.
 *
 * Accepts what someone reads off a bank app: `2499`, `2,499`, `₹2,499.00`,
 * `Rs 2499`. Returns null rather than guessing on anything else, because a
 * misparse here does not produce an error, it produces a *wrong verdict* —
 * and both directions are harmful. Parsing a real amount wrongly tells a
 * customer their genuine message is fake; parsing loosely enough to match
 * several inputs to one amount widens the guessing space the attempt cap
 * exists to close.
 */
export function parseClaimedAmount(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;

  const cleaned = String(input)
    .replace(/[₹,\s]/g, "")
    .replace(/^(rs|inr)\.?/i, "");

  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const rupees = Number(cleaned);
  if (!Number.isFinite(rupees) || rupees <= 0) return null;

  // Through an integer string, not `rupees * 100`: 24.99 * 100 is
  // 2498.9999999999995 in binary floating point, and rounding it silently
  // would make the comparison below approximate. An amount check that is
  // approximately right is a verification that is approximately worthless.
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/**
 * The verdict. No I/O, no clock, no side effects — the caller decides what to
 * persist, guided by `consumesAttempt` below.
 *
 * The ordering of the checks is deliberate. Everything that refuses is
 * answered before anything that could compare an amount, so a caller cannot
 * accidentally leak "this code exists" through a timing or attempt-count
 * difference on a code that was never going to answer anyway.
 */
export function decideVerification(params: {
  record: NudgeVerificationRecord | null;
  claimedAmountPaise: number | null;
  nowIso: string;
  attemptCap?: number;
}): VerificationOutcome {
  const { record, claimedAmountPaise, nowIso } = params;
  const cap = params.attemptCap ?? ATTEMPT_CAP;

  // The input never reached the record, so nothing about the record is
  // revealed and nothing is consumed.
  if (claimedAmountPaise === null) return { status: "malformed" };

  /**
   * No such code.
   *
   * This is the honest answer and it is also the *useful* one: a customer who
   * types the code from a phishing message and is told there is no such
   * payment has learned the thing they came to find out. It reveals nothing,
   * because there is no person behind a code that does not exist.
   */
  if (!record) return { status: "unknown" };

  if (record.attempts >= cap) return { status: "locked" };

  if (Date.parse(nowIso) > Date.parse(record.expiresAtIso)) return { status: "expired" };

  if (record.amountPaise !== claimedAmountPaise) {
    return { status: "mismatch", attemptsRemaining: Math.max(0, cap - (record.attempts + 1)) };
  }

  return {
    status: "verified",
    merchantName: record.merchantName,
    amountPaise: record.amountPaise,
    failedAtIso: record.failedAtIso,
    revenueEventId: record.revenueEventId,
  };
}

/**
 * Whether this outcome should burn one of the code's attempts.
 *
 * Only a wrong amount against a live code does. A correct answer does not,
 * because a customer checking the same message twice is not an attack. A
 * malformed input does not, because it never reached the record — otherwise
 * the cap could be exhausted by garbage that never tested anything, which is
 * a denial of service against the customer's own ability to verify.
 *
 * Kept as a function beside the verdict rather than inferred at the call site
 * so the policy is stated once and can be asserted directly.
 */
export function consumesAttempt(outcome: VerificationOutcome): boolean {
  return outcome.status === "mismatch";
}

/**
 * The line appended to an outbound recovery message.
 *
 * Deliberately phrased as an instruction to distrust the message. A security
 * affordance that says "this message is genuine" trains exactly the reflex
 * the attacker needs, since a phishing message can say that too. What a
 * phishing message cannot do is survive the check, so the copy points at the
 * check.
 */
export function buildVerificationLine(code: string, verifyUrl: string): string {
  return `Don't trust this message. Check it: ${verifyUrl} — code ${formatCode(code)}`;
}
