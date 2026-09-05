import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  metaTimestampToIso,
  parseStatusPayload,
  verifyMetaSignature,
  verifySubscription,
} from "../lib/whatsapp-status";

/**
 * Meta's delivery callback: the only source in this system for the word
 * "delivered".
 *
 * The signature tests matter more than the parsing ones. Anyone who could
 * post here unauthenticated could mark messages as delivered — which is
 * exactly the claim this project spends its whole architecture trying to make
 * honestly.
 */

const SECRET = "app-secret-not-a-real-one";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

const DELIVERED = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "123",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            statuses: [
              {
                id: "wamid.TEST1",
                status: "delivered",
                timestamp: "1757030400",
                recipient_id: "919876500001",
              },
            ],
          },
        },
      ],
    },
  ],
});

test("a genuine signature verifies", () => {
  assert.equal(verifyMetaSignature(DELIVERED, sign(DELIVERED), SECRET), true);
});

test("a forged signature is refused", () => {
  assert.equal(verifyMetaSignature(DELIVERED, sign(DELIVERED, "wrong-secret"), SECRET), false);
});

test("a tampered body is refused even with a signature that was once valid", () => {
  const header = sign(DELIVERED);
  const tampered = DELIVERED.replace("delivered", "read");
  assert.equal(verifyMetaSignature(tampered, header, SECRET), false);
});

test("an unset app secret refuses everything rather than trusting an empty key", () => {
  /**
   * The same bug as the Razorpay webhook, asserted again rather than assumed
   * learned. `createHmac("sha256", "")` does not throw — it computes a
   * perfectly valid HMAC with a key everyone knows, so an unconfigured deploy
   * would verify signatures forged by anyone and look rigorous doing it.
   */
  const forged = `sha256=${createHmac("sha256", "").update(DELIVERED, "utf8").digest("hex")}`;
  assert.equal(verifyMetaSignature(DELIVERED, forged, ""), false);
  assert.equal(verifyMetaSignature(DELIVERED, forged, undefined), false);
});

test("a missing or malformed signature header is refused", () => {
  assert.equal(verifyMetaSignature(DELIVERED, null, SECRET), false);
  assert.equal(verifyMetaSignature(DELIVERED, "", SECRET), false);
  // A bare hex digest without the algorithm prefix means a different scheme.
  assert.equal(
    verifyMetaSignature(DELIVERED, sign(DELIVERED).replace("sha256=", ""), SECRET),
    false
  );
  // A different algorithm claiming the same digest.
  assert.equal(
    verifyMetaSignature(DELIVERED, sign(DELIVERED).replace("sha256=", "sha1="), SECRET),
    false
  );
  // Non-hex of the right length must not throw its way to an accept.
  assert.equal(verifyMetaSignature(DELIVERED, `sha256=${"z".repeat(64)}`, SECRET), false);
});

test("a delivered status is parsed with its message id and time", () => {
  const { updates, malformed } = parseStatusPayload(JSON.parse(DELIVERED));
  assert.equal(malformed, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].provider_message_id, "wamid.TEST1");
  assert.equal(updates[0].state, "delivered");
  assert.equal(updates[0].at, new Date(1757030400 * 1000).toISOString());
});

test("Meta's vocabulary is stored unmapped", () => {
  // Not translated into a status of our own. A layer of our interpretation
  // between the provider's claim and the audit trail is the thing this
  // project exists to avoid.
  for (const state of ["sent", "delivered", "read", "failed"]) {
    const payload = JSON.parse(DELIVERED.replace("delivered", state));
    assert.equal(parseStatusPayload(payload).updates[0].state, state);
  }
});

test("a failure carries Meta's own error code", () => {
  const payload = JSON.parse(DELIVERED);
  payload.entry[0].changes[0].value.statuses[0].status = "failed";
  payload.entry[0].changes[0].value.statuses[0].errors = [
    { code: 131026, title: "Message undeliverable" },
  ];

  const { updates } = parseStatusPayload(payload);
  assert.equal(updates[0].state, "failed");
  assert.match(updates[0].error!, /meta_131026/);
});

test("a message-received callback yields no status updates", () => {
  // Meta sends inbound messages on the same subscription. Nothing to do with
  // them here, and nothing wrong with them either.
  const inbound = {
    entry: [{ changes: [{ field: "messages", value: { messages: [{ id: "wamid.IN" }] } }] }],
  };
  assert.equal(parseStatusPayload(inbound).updates.length, 0);
});

test("a malformed status is counted, never guessed at", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { status: "delivered" }, // no id — nothing to join on
                { id: "wamid.OK", status: "read", timestamp: "1757030400" },
              ],
            },
          },
        ],
      },
    ],
  };

  const { updates, malformed } = parseStatusPayload(payload);
  assert.equal(malformed, 1);
  assert.equal(updates.length, 1, "one bad entry does not cost the rest of the batch");
});

test("junk payloads do not throw", () => {
  // This is a public endpoint and a callback that throws is a callback Meta
  // retries for hours before disabling the subscription.
  for (const junk of [null, undefined, 42, "text", {}, { entry: "no" }, { entry: [null] }]) {
    assert.doesNotThrow(() => parseStatusPayload(junk));
  }
});

test("a missing timestamp becomes now, not 1970", () => {
  const now = Date.parse("2026-09-05T10:00:00.000Z");
  assert.equal(metaTimestampToIso(undefined, now), "2026-09-05T10:00:00.000Z");
  assert.equal(metaTimestampToIso("not-a-number", now), "2026-09-05T10:00:00.000Z");
  assert.equal(metaTimestampToIso("0", now), "2026-09-05T10:00:00.000Z");
});

test("the subscription handshake echoes the challenge only on an exact match", () => {
  const params = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "expected",
    "hub.challenge": "1234567890",
  });

  assert.deepEqual(verifySubscription(params, "expected"), { ok: true, challenge: "1234567890" });
  assert.equal(verifySubscription(params, "different").ok, false);
  // An unset token must not compare equal to whatever arrives.
  assert.equal(verifySubscription(params, undefined).ok, false);
  assert.equal(verifySubscription(params, "").ok, false);

  const wrongMode = new URLSearchParams(params);
  wrongMode.set("hub.mode", "unsubscribe");
  assert.equal(verifySubscription(wrongMode, "expected").ok, false);
});
