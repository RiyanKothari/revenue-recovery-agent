import type { RecoveryDb } from "./db";

/**
 * Where a customer checks a message. Every outgoing nudge names this path, so
 * it is a constant rather than a string typed into each place that mentions
 * it — the Attest demo once told judges to "check it at /attest", the operator
 * console, while real messages pointed at the customer page. A test pins the
 * demo copy to this value.
 */
export const VERIFY_PATH = "/verify";
import { resolveBaseUrl, resolveNudgeSecret } from "./app-secret";
import { resolveIdentity } from "./ledger-writer";
import {
  ATTEMPT_CAP,
  VERIFICATION_TTL_MS,
  consumesAttempt,
  decideVerification,
  deriveVerificationCode,
  normaliseCode,
  parseClaimedAmount,
  type VerificationOutcome,
} from "./nudge-verification";

/**
 * The Verified Nudge check, with the store attached.
 *
 * `lib/nudge-verification.ts` decides; this decides *when to ask it* and what
 * to persist afterwards. Kept apart so the verdict stays a pure function that
 * can be exhaustively asserted, and so the part that can fail — the database
 * — has one place to fail in.
 *
 * **This fails closed**, which is the opposite of `lib/rate-limit.ts` and
 * worth stating because the two sit next to each other in the same route.
 * The limiter fails open because the harm it prevents is a large query, and
 * refusing during a blip would take a dashboard panel offline to avoid a
 * hypothetical load spike. Here the harm is the entire point of the feature:
 * a check that answers "verified" when it could not actually check has told
 * someone a phishing message is genuine. There is no degraded mode for that,
 * so an unreachable store returns `unavailable` and the page says plainly
 * that it could not check.
 */

export type VerifierDb = Pick<
  RecoveryDb,
  "reserveVerificationAttempt" | "refundVerificationAttempt"
>;

export interface VerifierDeps {
  db: VerifierDb | null;
  /** Injected. Nothing in the verification path may read the wall clock. */
  now: () => Date;
  attemptCap?: number;
}

export type IssuerDb = Pick<
  RecoveryDb,
  "issueNudgeVerification" | "getSystemSecret" | "putSystemSecretIfAbsent"
>;

export interface IssuerDeps {
  db: IssuerDb;
  secret?: string;
  merchantName?: string;
  baseUrl?: string;
}

/**
 * Issues the challenge for one outbound recovery message.
 *
 * **Returns null instead of throwing, and the caller must send without a code
 * when it does.** That looks like the fail-open this codebase spends its
 * effort avoiding, and it is the opposite, because of which direction the
 * harm runs.
 *
 * A message with no code degrades to exactly what every recovery message in
 * the industry is today: unverifiable. Nothing is worse than before. But a
 * message that *carries* a code the store never recorded is actively
 * dangerous — the customer does the responsible thing, checks it, and is told
 * their genuine message is unrecognised. That trains them to distrust the one
 * signal that works, and the next real message gets ignored too.
 *
 * So the code reaches the customer only when the record behind it exists.
 * Refusing to send at all would be the third option, and it is the wrong one:
 * a database blip would stop revenue recovery entirely to protect a feature
 * whose absence costs nothing.
 */
export async function issueVerification(
  payment: { revenueEventId: string; amountPaise: number; failedAtIso: string },
  deps: IssuerDeps
): Promise<{ code: string; url: string } | null> {
  const baseUrl = deps.baseUrl?.replace(/\/+$/, "") ?? resolveBaseUrl();
  const merchantName = deps.merchantName ?? resolveIdentity().merchantId;

  // Without a base url the message would carry a code and nowhere to check
  // it, which is worse than carrying nothing. Everything else now has a
  // working default, so this is the only configuration that can stop a code
  // being issued — and on Vercel even this comes from the platform.
  if (!baseUrl) {
    console.error(
      "[nudge-verify] no APP_BASE_URL and no Vercel URL to fall back on — sending without a verification code."
    );
    return null;
  }

  try {
    /**
     * Generated on first use and stored, rather than demanded from the
     * environment. See lib/app-secret.ts for why this one secret may live in
     * the database: it protects rows in that same database, so an attacker
     * who could read it could already read what it protects.
     *
     * `deriveVerificationCode` still throws on an empty value, which is now
     * unreachable through this path and stays as the backstop it was.
     */
    const secret = deps.secret ?? (await resolveNudgeSecret(deps.db));
    const code = deriveVerificationCode(payment.revenueEventId, secret);

    const result = await deps.db.issueNudgeVerification({
      code,
      revenue_event_id: payment.revenueEventId,
      merchant_name: merchantName,
      amount_paise: payment.amountPaise,
      failed_at: payment.failedAtIso,
      expires_at: new Date(Date.parse(payment.failedAtIso) + VERIFICATION_TTL_MS).toISOString(),
    });

    /**
     * A duplicate is success, not failure. The code is derived from the event,
     * so a webhook redelivery writes the same row — and the row it collides
     * with is the one that makes this code checkable. Treating that as a
     * failure would strip the code from a retry of a message that is perfectly
     * verifiable.
     */
    void result;

    return { code, url: `${baseUrl}${VERIFY_PATH}` };
  } catch (err: any) {
    console.error(
      "[nudge-verify] could not issue a verification code, sending without one:",
      err?.message ?? err
    );
    return null;
  }
}

export async function verifyNudge(
  input: { code?: string | null; amount?: string | null },
  deps: VerifierDeps
): Promise<VerificationOutcome> {
  const cap = deps.attemptCap ?? ATTEMPT_CAP;

  /**
   * Both inputs are validated before the store is touched.
   *
   * Not an optimisation. An attempt is a scarce resource belonging to the
   * customer, and reserving one for input that never tested anything would
   * let a stranger exhaust a real person's five tries with five pieces of
   * nonsense and lock them out of checking their own message.
   */
  const claimedAmountPaise = parseClaimedAmount(input.amount);
  if (claimedAmountPaise === null) return { status: "malformed" };

  const code = normaliseCode(input.code);
  // A string that cannot be a code is answered exactly like a code nobody
  // issued, because that is what it is. No round trip, and no distinction for
  // an attacker to measure.
  if (!code) return { status: "unknown" };

  if (!deps.db) return { status: "unavailable" };

  try {
    /**
     * The attempt is taken BEFORE the amount is compared, and given back
     * below if the answer turns out to be right.
     *
     * Reading the count, deciding, and writing it back is the same
     * read-then-write that once let two concurrent webhook redeliveries both
     * pass an idempotency check and send one customer two payment links four
     * seconds apart. Here it would mean two concurrent guesses both consuming
     * the last remaining attempt, so the cap on guessing would quietly not be
     * a cap. Only the conditional update closes it.
     */
    const reservation = await deps.db.reserveVerificationAttempt(code, cap);

    if (!reservation) return { status: "unknown" };
    if (!reservation.reserved) return { status: "locked" };

    const outcome = decideVerification({
      record: {
        code: reservation.row.code,
        revenueEventId: reservation.row.revenue_event_id,
        merchantName: reservation.row.merchant_name,
        amountPaise: reservation.row.amount_paise,
        failedAtIso: reservation.row.failed_at,
        expiresAtIso: reservation.row.expires_at,
        // The count as it stood when this guess was made. The reservation has
        // already incremented it, so handing the post-increment value to the
        // decider would report one fewer attempt remaining than is true and,
        // on the last try, lock a customer out one guess early.
        attempts: Math.max(0, reservation.row.attempts - 1),
      },
      claimedAmountPaise,
      nowIso: deps.now().toISOString(),
      attemptCap: cap,
    });

    if (!consumesAttempt(outcome)) {
      /**
       * Only a wrong amount against a live code costs the customer anything.
       * A correct answer, or a code that had already expired, tested nothing
       * worth charging for — and a customer who re-checks the same message
       * twice must not be able to lock themselves out by being careful.
       *
       * Best effort on purpose: a failed refund means the customer has one
       * fewer try than they should, which is a far smaller harm than an
       * exception turning a successful verification into an error page.
       */
      try {
        await deps.db.refundVerificationAttempt(code);
      } catch (err: any) {
        console.error(
          `[nudge-verify] could not return an attempt for a non-guess (${outcome.status}):`,
          err?.message ?? err
        );
      }
    }

    return outcome;
  } catch (err: any) {
    console.error("[nudge-verify] store unavailable, refusing to answer:", err?.message ?? err);
    return { status: "unavailable" };
  }
}
