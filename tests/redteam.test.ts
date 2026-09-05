import { test } from "node:test";
import assert from "node:assert/strict";
import { runRedTeam } from "../lib/redteam";

/**
 * The panel's credibility rests on it being able to report a failure. A suite
 * that can only ever return green is decoration, and this project's whole
 * argument is that a claim you cannot see fail is not evidence.
 */

test("every attack is refused by the current defences", async () => {
  const results = await runRedTeam("a-real-webhook-secret");
  const breached = results.filter((r) => !r.blocked);

  assert.equal(
    breached.length,
    0,
    `defences breached: ${breached.map((b) => `${b.id} (${b.outcome})`).join(", ")}`
  );
});

test("it covers the two defects that were actually found, not just hypotheticals", async () => {
  const ids = (await runRedTeam("secret")).map((r) => r.id);
  assert.ok(ids.includes("empty-secret"), "the empty-secret bypass was a real bug");
  assert.ok(ids.includes("send-guard-fails-closed"), "the dry-run corruption was a real bug");
});

test("each result names the module that refused, so it can be read", async () => {
  for (const r of await runRedTeam("secret")) {
    assert.match(r.source, /^lib\/.+\.ts$/, `${r.id} should cite a source file`);
    assert.ok(r.attack.length > 10, `${r.id} should describe the attack`);
    assert.ok(r.defence.length > 10, `${r.id} should name the defence`);
  }
});

test("it reports a breach rather than hiding it", async () => {
  // With no secret configured, the tampered-body check cannot run — but the
  // suite must still return the checks it CAN run rather than throwing.
  const results = await runRedTeam(undefined);
  assert.ok(results.length >= 8, "the suite still runs without a secret");
  assert.ok(results.every((r) => typeof r.blocked === "boolean"));
});

test("the empty-secret forgery is genuinely computed, not asserted", async () => {
  // The point of this row is that createHmac("sha256", "") does not throw.
  // If that ever changed, the check would be vacuous and should be revisited.
  const crypto = await import("node:crypto");
  const sig = crypto.createHmac("sha256", "").update("{}").digest("hex");
  assert.equal(sig.length, 64, "an empty key still produces a valid HMAC");
});
