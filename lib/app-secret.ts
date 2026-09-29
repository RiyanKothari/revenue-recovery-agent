import crypto from "crypto";
import type { RecoveryDb } from "./db";

/**
 * Secrets the application can generate for itself.
 *
 * ## Why this exists
 *
 * `NUDGE_VERIFICATION_SECRET` keys the derivation of every Verified Nudge
 * code. Without it, `deriveVerificationCode` throws — deliberately, because
 * an empty HMAC key would make every code in the system computable by anyone
 * holding an event id, which turns the anti-phishing tool into a phishing
 * tool. That refusal is correct and stays.
 *
 * But it meant the feature was dark until somebody pasted a value into a
 * deployment console, and a security feature that is off by default until a
 * manual step happens is a security feature that is usually off.
 *
 * ## Why the database is an acceptable home for it
 *
 * The obvious objection is that secrets belong in a secret manager, not a
 * table. That is right in general and not right here, for one specific
 * reason: **this secret protects rows in the same database.**
 *
 * An attacker who can read `system_secrets` can already read
 * `nudge_verifications`, which contains the codes themselves along with the
 * amounts and merchants they attest to. Deriving codes would tell them
 * nothing they could not simply select. So storing the key beside the data it
 * protects adds no meaningful exposure, while removing a manual step that was
 * reliably being skipped.
 *
 * That argument does NOT generalise. It would be wrong for the Razorpay
 * webhook secret, which is shared with a third party and protects the
 * integrity of data arriving from outside; wrong for the WhatsApp token,
 * which spends money; and wrong for anything a different system also holds.
 * Those stay in the environment.
 *
 * ## Explicit configuration always wins
 *
 * An operator who sets the variable gets their value, every time. Generation
 * is the floor, not the policy — otherwise rotating the secret by changing
 * the environment would silently do nothing.
 */

/** The one secret this module is willing to generate. */
export const NUDGE_SECRET_NAME = "nudge_verification";

export type SecretDb = Pick<RecoveryDb, "getSystemSecret" | "putSystemSecretIfAbsent">;

/**
 * Resolves the nudge secret, generating and persisting one if none exists.
 *
 * Throws when the database cannot answer, rather than falling back to
 * anything. A generated secret that is not persisted would be a different key
 * on every lambda instance, so codes issued by one would fail verification on
 * another — which presents to the customer as a genuine message being called
 * fake, the single worst output this feature has.
 */
export async function resolveNudgeSecret(
  db: SecretDb,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const configured = env.NUDGE_VERIFICATION_SECRET?.trim();
  if (configured) return configured;

  const existing = await db.getSystemSecret(NUDGE_SECRET_NAME);
  if (existing) return existing;

  /**
   * 32 bytes, and the write is conditional.
   *
   * Two cold instances can reach this line at the same moment, and both would
   * generate a different key. `putSystemSecretIfAbsent` returns whichever one
   * actually landed, so both callers continue with the same value — the same
   * reasoning as every other read-then-write in this codebase, and the
   * consequence of getting it wrong is worse than most: two keys in
   * circulation means half the codes in flight stop verifying.
   */
  const generated = crypto.randomBytes(32).toString("hex");
  return db.putSystemSecretIfAbsent(NUDGE_SECRET_NAME, generated);
}

/**
 * Where a customer checks a recovery message.
 *
 * Vercel sets `VERCEL_PROJECT_PRODUCTION_URL` on every deployment, so the
 * production URL is already known to the process and asking an operator to
 * type it again was asking them to repeat something the platform had told us.
 * `VERCEL_URL` is the per-deployment host, used only as a second resort
 * because a preview URL in a customer's message would stop working when the
 * preview is torn down.
 *
 * Returns null rather than guessing when nothing is available. A message
 * carrying a code and no way to check it is worse than one carrying neither.
 */
export function resolveBaseUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const explicit = env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const host = env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || env.VERCEL_URL?.trim();
  if (!host) return null;

  // The platform gives a bare host; a customer needs a URL they can tap.
  return host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host}`;
}
