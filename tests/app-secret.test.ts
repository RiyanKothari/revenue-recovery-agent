import { test } from "node:test";
import assert from "node:assert/strict";
import { NUDGE_SECRET_NAME, resolveBaseUrl, resolveNudgeSecret } from "../lib/app-secret";
import type { SecretDb } from "../lib/app-secret";
import { resolveIdentity } from "../lib/ledger-writer";
import { deriveVerificationCode } from "../lib/nudge-verification";

/**
 * Zero-configuration startup.
 *
 * Every default here exists because a feature that needs a manual step before
 * it works is a feature that is usually off. What none of them do is weaken a
 * refusal: `deriveVerificationCode` still throws on an empty key, and these
 * simply make an empty key unreachable.
 */

function store(initial: Record<string, string> = {}): SecretDb & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    async getSystemSecret(name) {
      return rows.get(name) ?? null;
    },
    async putSystemSecretIfAbsent(name, value) {
      if (!rows.has(name)) rows.set(name, value);
      // The winner's value, not the caller's.
      return rows.get(name)!;
    },
  };
}

// --- the secret

test("a configured secret always wins", () => {
  /**
   * Generation is the floor, not the policy. If a stored secret outranked the
   * environment, rotating the key by changing configuration would silently do
   * nothing — the worst possible outcome for a rotation.
   */
  return (async () => {
    const db = store({ [NUDGE_SECRET_NAME]: "stored-value" });
    const resolved = await resolveNudgeSecret(db, { NUDGE_VERIFICATION_SECRET: "from-env" });
    assert.equal(resolved, "from-env");
  })();
});

test("a blank configured secret does not count as configured", () => {
  // .env templates ship this variable present-but-empty, so "set to nothing"
  // is the default state rather than an exotic one.
  return (async () => {
    const db = store({ [NUDGE_SECRET_NAME]: "stored-value" });
    assert.equal(await resolveNudgeSecret(db, { NUDGE_VERIFICATION_SECRET: "   " }), "stored-value");
  })();
});

test("with nothing configured it generates one and keeps it", async () => {
  const db = store();

  const first = await resolveNudgeSecret(db, {});
  assert.equal(first.length, 64, "32 bytes as hex");
  assert.match(first, /^[0-9a-f]{64}$/);

  // Stable across calls, or codes issued yesterday stop verifying today.
  const second = await resolveNudgeSecret(db, {});
  assert.equal(second, first);
});

test("two cold instances racing end up with the same key", async () => {
  /**
   * The consequence of getting this wrong is worse than most races: two keys
   * in circulation means half the codes in flight stop verifying, which
   * reaches the customer as a genuine message being called fake.
   */
  const db = store();

  const [a, b, c] = await Promise.all([
    resolveNudgeSecret(db, {}),
    resolveNudgeSecret(db, {}),
    resolveNudgeSecret(db, {}),
  ]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(db.rows.size, 1, "exactly one key was kept");
});

test("a generated secret really does key the codes", async () => {
  // The whole point: the derivation works without anybody configuring it.
  const secret = await resolveNudgeSecret(store(), {});
  const code = deriveVerificationCode("11111111-2222-3333-4444-555555555555", secret);
  assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
});

test("an unreachable store throws rather than inventing a key", async () => {
  /**
   * A per-instance key would mean codes issued by one lambda fail
   * verification on another. Failing loudly is the only safe answer, and the
   * caller already degrades to sending without a code.
   */
  const broken: SecretDb = {
    async getSystemSecret() {
      throw new Error("connection terminated");
    },
    async putSystemSecretIfAbsent() {
      throw new Error("connection terminated");
    },
  };

  await assert.rejects(() => resolveNudgeSecret(broken, {}), /connection terminated/);
});

// --- the base url

test("the platform's own URL is used before asking anyone to type it", () => {
  assert.equal(
    resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "example.vercel.app" }),
    "https://example.vercel.app"
  );
  // Explicit configuration still wins, and a trailing slash never doubles up.
  assert.equal(
    resolveBaseUrl({ APP_BASE_URL: "https://pay.example.com/", VERCEL_URL: "x.vercel.app" }),
    "https://pay.example.com"
  );
  // The production URL outranks the per-deployment one: a preview host in a
  // customer's message stops working when the preview is torn down.
  assert.equal(
    resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "prod.vercel.app", VERCEL_URL: "preview.vercel.app" }),
    "https://prod.vercel.app"
  );
});

test("with no URL anywhere it returns null rather than guessing", () => {
  // A message carrying a code and nowhere to check it is worse than one
  // carrying neither.
  assert.equal(resolveBaseUrl({}), null);
});

// --- the merchant identity

test("the deployment names itself before admitting it is unconfigured", () => {
  assert.equal(
    resolveIdentity({ VERCEL_PROJECT_PRODUCTION_URL: "revenue-recovery-agent-plum.vercel.app" })
      .merchantId,
    "revenue-recovery-agent-plum"
  );

  assert.equal(
    resolveIdentity({ MERCHANT_NAME: "Kettle & Co", VERCEL_URL: "x.vercel.app" }).merchantId,
    "Kettle & Co"
  );
});

test("the last-resort label stays deliberately ugly", () => {
  /**
   * A fairness report headed `unconfigured_merchant` is a configuration
   * problem announcing itself in the one place somebody will read it. A
   * plausible-looking default would hide the fact that nobody said who this
   * is.
   */
  assert.equal(resolveIdentity({}).merchantId, "unconfigured_merchant");
});
