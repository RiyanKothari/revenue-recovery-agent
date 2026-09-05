import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeMetaError,
  isDryRun,
  isSyntheticNumber,
  normaliseRecipient,
  sendWhatsAppRetryNudge,
} from "../lib/whatsapp";

/**
 * This send path had never once succeeded when it was written — the access
 * token expired before a real send was attempted — so it is the largest
 * untested surface that will run live during a demo.
 *
 * The distinction every assertion here protects: a configuration problem
 * must never be recorded as a customer who did not receive their message.
 */

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    process.env = saved;
  }
}

test("a blank test recipient is not treated as a configured one", async () => {
  // .env.local ships WHATSAPP_TEST_RECIPIENT present-but-empty. With `??`
  // an empty string counted as configured, and every live message would have
  // been addressed to "" — arriving nowhere, while the error blamed Meta.
  const result = await withEnv(
    {
      WHATSAPP_PHONE_NUMBER_ID: "123",
      WHATSAPP_ACCESS_TOKEN: "tok",
      WHATSAPP_DRY_RUN: "false",
      WHATSAPP_TEST_RECIPIENT: "",
    },
    // Exactly what the generator emits: `9198765` + zero-padded index.
    () =>
      sendWhatsAppRetryNudge({
        toPhoneE164: "+919876543000",
        paymentLinkUrl: "u",
        amountRupees: 1,
      })
  );

  // Falls through to the synthetic guard rather than sending to "".
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /refused_synthetic_recipient/);
});

test("the synthetic-number guard does not fail open on longer numbers", () => {
  // The old pattern required exactly five trailing digits, which `43000 + i`
  // outgrows past ~57,000 events. A guard whose correctness depends on the
  // batch size is not a guard.
  assert.equal(isSyntheticNumber("919876544199"), true);
  assert.equal(isSyntheticNumber("9198765100000"), true, "six trailing digits still blocked");
  assert.equal(isSyntheticNumber("+919876543000"), true);
  assert.equal(isSyntheticNumber("+91 98765 43000".replace(/ /g, "")), true);
});

test("a real number is not mistaken for a seeded one", () => {
  // Over-blocking would refuse the demo's own recipient.
  assert.equal(isSyntheticNumber("+919812345678"), false);
  assert.equal(isSyntheticNumber("+14155550123"), false);
});

test("recipients are normalised to digits", () => {
  assert.equal(normaliseRecipient("+91 98765-43210"), "919876543210");
  assert.equal(normaliseRecipient("919876543210"), "919876543210");
});

test("dry run reports success without contacting Meta", async () => {
  const result = await withEnv(
    {
      WHATSAPP_PHONE_NUMBER_ID: "123",
      WHATSAPP_ACCESS_TOKEN: "tok",
      WHATSAPP_DRY_RUN: "true",
    },
    () => sendWhatsAppRetryNudge({ toPhoneE164: "+919812345678", paymentLinkUrl: "u", amountRupees: 12 })
  );

  assert.equal(result.success, true);
  assert.equal(result.messageId, "dry-run");
});

test("missing credentials are named as configuration, not delivery", async () => {
  const result = await withEnv(
    { WHATSAPP_PHONE_NUMBER_ID: undefined, WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_DRY_RUN: "false" },
    () => sendWhatsAppRetryNudge({ toPhoneE164: "+919812345678", paymentLinkUrl: "u", amountRupees: 1 })
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not_configured/);
});

test("an unusable recipient is refused before reaching Meta", async () => {
  const result = await withEnv(
    {
      WHATSAPP_PHONE_NUMBER_ID: "123",
      WHATSAPP_ACCESS_TOKEN: "tok",
      WHATSAPP_DRY_RUN: "false",
      WHATSAPP_TEST_RECIPIENT: "123",
    },
    () => sendWhatsAppRetryNudge({ toPhoneE164: "+919812345678", paymentLinkUrl: "u", amountRupees: 1 })
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /invalid_recipient/);
});

// --- error attribution -----------------------------------------------------

test("an expired token is named as ours, not as a delivery failure", () => {
  const msg = describeMetaError(
    { error: { code: 190, message: "Session has expired on Tuesday" } },
    401
  );
  assert.match(msg, /token_expired/);
  assert.match(msg, /System User token/);
});

test("a missing template names the language too", () => {
  // An en_US template sent as en fails exactly like a missing one, and the
  // error from Meta names neither.
  const msg = describeMetaError(
    { error: { code: 132001, message: "template name (x) does not exist in en" } },
    400
  );
  assert.match(msg, /template_missing/);
  assert.match(msg, /language code/);
});

test("an unverified recipient is named as a dashboard setting", () => {
  const msg = describeMetaError(
    { error: { code: 131030, message: "Recipient phone number not in allowed list" } },
    400
  );
  assert.match(msg, /recipient_not_allowed/);
  assert.match(msg, /verified list/);
});

test("a genuine undeliverable is not disguised as configuration", () => {
  // The one branch that IS the recipient's situation must still say so.
  const msg = describeMetaError({ error: { code: 131026, message: "Message undeliverable" } }, 400);
  assert.match(msg, /undeliverable/);
  assert.doesNotMatch(msg, /token|template|configured/i);
});

test("rate limiting is attributed to our send rate", () => {
  assert.match(describeMetaError({ error: { code: 4, message: "rate limit" } }, 429), /rate_limited/);
});

test("an unrecognised error still carries its code and message", () => {
  // Falling through to a bare "unknown" would strip the only clue available.
  const msg = describeMetaError({ error: { code: 99999, message: "something new" } }, 400);
  assert.match(msg, /99999/);
  assert.match(msg, /something new/);
});

test("an empty error body does not throw", () => {
  assert.ok(describeMetaError(null, 500).length > 0);
  assert.ok(describeMetaError({}, 500).length > 0);
});

/**
 * The send guard is the one rule whose failure reaches strangers' phones, so
 * it fails closed like every other rule in this system. It did not always:
 * it engaged only on an exact "true", and an edit that left the line reading
 * `WHATSAPP_DRY_RUN=true          -> log instead of sending (safest)` silently
 * switched the pipeline to live sends.
 */
test("anything other than an explicit false means dry run", () => {
  for (const value of [
    undefined,
    "",
    "true",
    "TRUE",
    " true ",
    "yes",
    "0",
    "true          -> log instead of sending (safest)", // the real corruption
    "False ", // whitespace tolerated on the explicit opt-out
  ]) {
    const dry = isDryRun({ WHATSAPP_DRY_RUN: value } as any);
    if (value === "False ") {
      assert.equal(dry, false, "an explicit false, whitespace aside, sends");
    } else {
      assert.equal(dry, true, `${JSON.stringify(value)} must not enable live sends`);
    }
  }
});

test("live sending requires the deliberate word", () => {
  assert.equal(isDryRun({ WHATSAPP_DRY_RUN: "false" } as any), false);
  assert.equal(isDryRun({} as any), true, "an absent variable never sends");
});

test("Meta's own status is carried through, not rounded up to delivered", async () => {
  // "accepted" means queued. Meta queues a message for ANY recipient and only
  // actually delivers to numbers on the test number's allowed list — so an
  // unverified recipient produces an ordinary 200 with a message id and
  // nothing ever arrives. The audit trail was recording that as delivery.
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    new Response(
      JSON.stringify({
        messages: [{ id: "wamid.TEST", message_status: "accepted" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  try {
    const result = await withEnv(
      {
        WHATSAPP_PHONE_NUMBER_ID: "123",
        WHATSAPP_ACCESS_TOKEN: "tok",
        WHATSAPP_DRY_RUN: "false",
        WHATSAPP_TEST_RECIPIENT: "+919812345678",
      },
      () =>
        sendWhatsAppRetryNudge({
          toPhoneE164: "+919812345678",
          paymentLinkUrl: "u",
          amountRupees: 1,
        })
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, "wamid.TEST", "the id must be traceable");
    assert.equal(result.status, "accepted", "Meta's word, not ours");
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});
