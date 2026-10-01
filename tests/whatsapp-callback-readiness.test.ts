import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  CALLBACK_PATH,
  assessCallbackReadiness,
  checkAppSecret,
  checkCallbackUrl,
  checkVerifyToken,
  readSubscription,
} from "../lib/whatsapp-callback-readiness";
import { verifyMetaSignature } from "../lib/whatsapp-status";

/**
 * Whether a delivery callback can arrive at all.
 *
 * The assertions worth writing are about the failures that are otherwise
 * silent. A missing app secret is a 401 in a log nobody reads; a missing
 * subscription is nothing at all. Both present as "the delivery panel says
 * unevidenced", which is also what a correctly-configured deployment that
 * has simply not sent anything yet looks like.
 */

const GOOD_SECRET = "0123456789abcdef0123456789abcdef";

// --- the app secret

test("an unset app secret is named as the reason callbacks never arrive", () => {
  /**
   * The failure is deliberate — lib/whatsapp-status.ts refuses every callback
   * rather than verifying with an empty key, because `createHmac("sha256","")`
   * does not throw and would accept forged signatures. Correct, and invisible:
   * the check has to say what the refusal costs.
   */
  for (const unset of [undefined, "", "   "]) {
    const check = checkAppSecret(unset);
    assert.equal(check.status, "fail");
    assert.match(check.detail, /every delivery callback is refused/);
    assert.match(check.fix!, /unevidenced/);
  }
});

test("the refusal the runtime actually performs is the one being reported", () => {
  /**
   * Pins this module to `verifyMetaSignature` rather than to a belief about
   * it. If the webhook ever started accepting an empty secret, this check
   * would still be reporting a failure that no longer happens — which is the
   * drift the whole module exists to avoid.
   */
  const body = JSON.stringify({ entry: [] });
  const signature = `sha256=${createHmac("sha256", GOOD_SECRET).update(body, "utf8").digest("hex")}`;

  assert.equal(verifyMetaSignature(body, signature, undefined), false, "unset refuses");
  assert.equal(verifyMetaSignature(body, signature, ""), false, "empty refuses");
  assert.equal(verifyMetaSignature(body, signature, GOOD_SECRET), true, "a real secret verifies");

  assert.equal(checkAppSecret(undefined).status, "fail");
  assert.equal(checkAppSecret(GOOD_SECRET).status, "ok");
});

test("decoration that survived a paste is caught, because the HMAC covers it verbatim", () => {
  /**
   * This project's own history. `WHATSAPP_DRY_RUN` once read
   * `true          -> log instead of sending (safest)`, which is not "true",
   * and the pipeline switched itself to live sends. A secret with a trailing
   * space signs perfectly over the wrong key, and presents as Meta sending
   * bad signatures.
   */
  for (const decorated of [
    `${GOOD_SECRET} `,
    ` ${GOOD_SECRET}`,
    `"${GOOD_SECRET}"`,
    `${GOOD_SECRET} # app secret`,
  ]) {
    const check = checkAppSecret(decorated);
    assert.equal(check.status, "fail", `should refuse ${JSON.stringify(decorated)}`);
    assert.match(check.detail, /whitespace|quotes|embedded space/);
  }
});

test("a decorated secret really would break the signature, not just look wrong", () => {
  // The claim the check above makes, demonstrated rather than asserted.
  const body = JSON.stringify({ entry: [] });
  const metaSignature = `sha256=${createHmac("sha256", GOOD_SECRET).update(body, "utf8").digest("hex")}`;

  assert.equal(verifyMetaSignature(body, metaSignature, `${GOOD_SECRET} `), false);
});

test("a secret of the wrong shape warns rather than refuses", () => {
  /**
   * The app id, the WABA id and the access token all sit next to the app
   * secret on the same dashboard page, and none is 32 hex characters. But the
   * format is Meta's to change, so refusing a credential for failing a pattern
   * we inferred would be this project asserting something it cannot evidence.
   */
  const check = checkAppSecret("1234567890123456");
  assert.equal(check.status, "warn");
  assert.match(check.fix!, /App ID|access token/i);

  assert.equal(checkAppSecret(GOOD_SECRET).status, "ok");
  assert.equal(checkAppSecret(GOOD_SECRET.toUpperCase()).status, "ok", "case is not the point");
});

// --- the verify token

test("without a verify token the URL cannot be registered in the first place", () => {
  const check = checkVerifyToken(undefined);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /handshake refuses/);
  assert.match(check.fix!, /no callback is ever sent/);
});

test("the verify token is compared exactly, so decoration fails it too", () => {
  assert.equal(checkVerifyToken(" hunter2").status, "fail");
  assert.equal(checkVerifyToken("hunter2 # whatever").status, "fail");
  assert.equal(checkVerifyToken("hunter2").status, "ok");
});

// --- the URL

test("the callback URL is derived, never asked for a second time", () => {
  const check = checkCallbackUrl("https://example.vercel.app");
  assert.equal(check.status, "ok");
  assert.equal(check.detail, `https://example.vercel.app${CALLBACK_PATH}`);
});

test("running locally is a warning with an explanation, not a failure", () => {
  // Nothing is misconfigured — Meta simply cannot reach a laptop.
  const check = checkCallbackUrl(null);
  assert.equal(check.status, "warn");
  assert.match(check.fix!, /Meta cannot reach this process/);
});

// --- the subscription, the only one Meta can confirm

test("an empty subscription list is a failure, however correct this side is", () => {
  const check = readSubscription({ ok: true, body: { data: [] } });
  assert.equal(check.status, "fail");
  assert.match(check.detail, /no app is subscribed/);
  assert.match(check.fix!, /every send stays unconfirmed/);
});

test("a subscribed app is reported with its count", () => {
  const check = readSubscription({
    ok: true,
    body: { data: [{ whatsapp_business_api_data: { id: "1" } }] },
  });
  assert.equal(check.status, "ok");
  assert.match(check.detail, /1 app\(s\) subscribed/);
});

test("a failed lookup is unknown, not unsubscribed", () => {
  /**
   * An expired token cannot tell you whether a subscription exists. Reporting
   * that as "not subscribed" would send someone to reconfigure a callback
   * that was already fine.
   */
  const check = readSubscription({
    ok: false,
    body: { error: { message: "Session has expired", code: 190 } },
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /could not check: Session has expired/);
});

test("a response shaped unlike anything expected does not throw", () => {
  // A public API's payload shape is not ours, and a preflight that crashes
  // tells you less than one that says it does not know.
  for (const body of [null, undefined, "not json", { data: "not an array" }, {}]) {
    const check = readSubscription({ ok: true, body });
    assert.equal(check.status, "fail", "nothing parseable means nothing subscribed");
  }
});

// --- the set

test("the offline checks report in the order they block each other", () => {
  /**
   * A missing secret makes the subscription moot, so it is reported first.
   * The ordering is the advice: fixing them bottom-up means re-running the
   * whole thing after each one.
   */
  const checks = assessCallbackReadiness({
    appSecret: undefined,
    verifyToken: undefined,
    baseUrl: null,
  });

  assert.deepEqual(
    checks.map((c) => c.status),
    ["fail", "fail", "warn"]
  );
  assert.ok(checks.every((c) => c.fix), "a check that is not ok always says what to do");
});

test("a fully configured deployment reports clean", () => {
  const checks = assessCallbackReadiness({
    appSecret: GOOD_SECRET,
    verifyToken: "hunter2",
    baseUrl: "https://example.vercel.app",
  });

  assert.ok(checks.every((c) => c.status === "ok"), JSON.stringify(checks));
});
