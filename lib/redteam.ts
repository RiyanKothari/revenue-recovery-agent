import crypto from "crypto";
import { verifyRazorpaySignature } from "./verify-webhook";
import { resolveEventTime } from "./event-time";
import { looksLikeEventId } from "./api-errors";
import { checkGuardrails } from "./guardrails";
import { isSyntheticNumber, isDryRun } from "./whatsapp";
import { ALLOWED_ACTIONS } from "./decision-model";

/**
 * The safety engineering, made visible.
 *
 * Every defence in this system is invisible when it works — a fail-closed
 * guardrail looks exactly like no guardrail until something attacks it. That
 * is a problem for a five-minute demo: the most differentiated work in the
 * project is the work nobody can see.
 *
 * So this runs real hostile inputs against the real defences and reports what
 * happened. Two rules keep it honest:
 *
 *   1. **It calls production code.** Not a reimplementation, not a mock —
 *      `verifyRazorpaySignature`, `resolveEventTime`, `looksLikeEventId` and
 *      `checkGuardrails` are the same functions the webhook runs. A red team
 *      that tests a copy of the system proves nothing about the system.
 *
 *   2. **Nothing here writes.** Attacks that would persist a row are
 *      demonstrated against the pure functions that would have rejected them,
 *      rather than actually inserted. A safety demo that pollutes the audit
 *      trail it is trying to vouch for has defeated itself.
 *
 * A check that FAILS is reported as failed. The point is a real result, not a
 * row of green ticks — if one of these ever goes red it means a defence has
 * regressed, and hiding that would make the panel worse than useless.
 */

export interface AttackResult {
  id: string;
  /** What a hostile client tried. */
  attack: string;
  /** The defence that was supposed to stop it. */
  defence: string;
  /** What the system actually did. */
  outcome: string;
  /** True when the attack was refused, i.e. the defence held. */
  blocked: boolean;
  /** Which module did the refusing, for anyone who wants to read it. */
  source: string;
}

const SAMPLE_BODY = JSON.stringify({
  event: "payment.failed",
  payload: { payment: { entity: { id: "pay_attack", amount: 500000 } } },
});

/**
 * Guardrail stub that reports a customer who has opted out.
 *
 * The consent check is the one rule with no exceptions, so it is worth
 * exercising directly rather than hoping the seeded batch contains a DND
 * customer at the moment the panel is opened.
 */
const dndCustomerDb = {
  async getConsent() {
    return { dnd: true };
  },
  async countActionsForEvent() {
    return 0;
  },
  async hasActionForCustomerSince() {
    return false;
  },
  async getEventPaymentId() {
    return null;
  },
  async hasDisputeFlag() {
    return false;
  },
};

/** A database that cannot answer — every guardrail must refuse, not proceed. */
const brokenDb = {
  async getConsent(): Promise<{ dnd: boolean } | null> {
    throw new Error("connection reset");
  },
  async countActionsForEvent(): Promise<number> {
    throw new Error("connection reset");
  },
  async hasActionForCustomerSince(): Promise<boolean> {
    throw new Error("connection reset");
  },
  async getEventPaymentId(): Promise<string | null> {
    throw new Error("connection reset");
  },
  async hasDisputeFlag(): Promise<boolean> {
    throw new Error("connection reset");
  },
};

export async function runRedTeam(webhookSecret: string | undefined): Promise<AttackResult[]> {
  const results: AttackResult[] = [];
  const now = new Date();

  // --- 1. Forge a signature. -------------------------------------------
  const forged = crypto.createHmac("sha256", "attacker-guess").update(SAMPLE_BODY).digest("hex");
  const forgedAccepted = verifyRazorpaySignature(SAMPLE_BODY, forged, webhookSecret);
  results.push({
    id: "forged-signature",
    attack: "Post a payment.failed signed with a guessed secret",
    defence: "HMAC-SHA256 verification, constant-time comparison",
    outcome: forgedAccepted ? "ACCEPTED — signature verification is broken" : "Rejected",
    blocked: !forgedAccepted,
    source: "lib/verify-webhook.ts",
  });

  // --- 2. Tamper with a body after it was legitimately signed. ---------
  if (webhookSecret) {
    const honest = crypto.createHmac("sha256", webhookSecret).update(SAMPLE_BODY).digest("hex");
    const tampered = SAMPLE_BODY.replace('"amount":500000', '"amount":50000000');
    const tamperedAccepted = verifyRazorpaySignature(tampered, honest, webhookSecret);
    results.push({
      id: "tampered-body",
      attack: "Inflate the amount 100x on a validly signed body",
      defence: "The signature covers the raw body, not a parsed subset",
      outcome: tamperedAccepted ? "ACCEPTED — the body is not covered" : "Rejected",
      blocked: !tamperedAccepted,
      source: "lib/verify-webhook.ts",
    });
  }

  // --- 3. The empty-secret bypass. -------------------------------------
  // createHmac("sha256", "") does NOT throw; it computes a valid HMAC with a
  // key everyone knows. This was a real bypass in this codebase.
  const emptyKeyForgery = crypto.createHmac("sha256", "").update(SAMPLE_BODY).digest("hex");
  const emptyAccepted = verifyRazorpaySignature(SAMPLE_BODY, emptyKeyForgery, "");
  results.push({
    id: "empty-secret",
    attack: "Forge with an empty key against an unconfigured secret",
    defence: "A missing or blank secret is a refusal, never a key",
    outcome: emptyAccepted ? "ACCEPTED — anyone can forge" : "Rejected",
    blocked: !emptyAccepted,
    source: "lib/verify-webhook.ts",
  });

  // --- 4. Backdate an event out of its own cooldown window. ------------
  const ancient = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
  const backdated = resolveEventTime(ancient, now);
  results.push({
    id: "backdated-event",
    attack: "Claim the payment failed in 2020, escaping the cooldown window",
    defence: "created_at is attacker-influenced; implausible values are refused",
    outcome: backdated.receivedAt
      ? "ACCEPTED — the event was backdated"
      : `Refused (${backdated.rejected})`,
    blocked: backdated.receivedAt === null,
    source: "lib/event-time.ts",
  });

  // --- 5. Consent. The rule with no exceptions. ------------------------
  const dnd = await checkGuardrails(
    "cust_opted_out",
    "evt_redteam",
    now.toISOString(),
    dndCustomerDb as any
  );
  results.push({
    id: "dnd-customer",
    attack: "Recover a payment from a customer who has opted out",
    defence: "Consent is checked first, before the agent is asked anything",
    outcome: dnd.allowed ? "ALLOWED — a DND customer would be contacted" : `Blocked (${dnd.reason})`,
    blocked: !dnd.allowed,
    source: "lib/guardrails.ts",
  });

  // --- 6. Break the database mid-check. --------------------------------
  const degraded = await checkGuardrails(
    "cust_any",
    "evt_redteam",
    now.toISOString(),
    brokenDb as any
  );
  results.push({
    id: "degraded-guardrail",
    attack: "Take the database down so the safety checks cannot be evaluated",
    defence: "Fail closed — a rule that cannot prove safety does not permit action",
    outcome: degraded.allowed
      ? "ALLOWED — an outage disables the guardrails"
      : `Refused (${degraded.reason})`,
    blocked: !degraded.allowed,
    source: "lib/guardrails.ts",
  });

  // --- 7. SQL injection through the one user-controlled input. ---------
  const injection = "'; drop table revenue_events; --";
  const injectionAccepted = looksLikeEventId(injection);
  results.push({
    id: "sql-injection",
    attack: `Pass "${injection}" as an event id`,
    defence: "Shape-checked before the query; parameterised regardless",
    outcome: injectionAccepted ? "ACCEPTED — reached the database" : "Rejected as not an id (404)",
    blocked: !injectionAccepted,
    source: "lib/api-errors.ts",
  });

  // --- 8. An action outside the permitted set. -------------------------
  const rogue = "transfer_funds_to_attacker";
  const rogueAllowed = (ALLOWED_ACTIONS as readonly string[]).includes(rogue);
  results.push({
    id: "out-of-bounds-action",
    attack: `Have the model return "${rogue}"`,
    defence: "The action set is enforced twice — JSON schema, then again in code",
    outcome: rogueAllowed ? "ACCEPTED — arbitrary actions execute" : "Rejected, escalated to a human",
    blocked: !rogueAllowed,
    source: "lib/decision-engine.ts",
  });

  // --- 9. Message a seeded number. -------------------------------------
  const seeded = "+919876543000";
  const seededBlocked = isSyntheticNumber(seeded);
  results.push({
    id: "synthetic-recipient",
    attack: `Send a real WhatsApp to a seeded demo number (${seeded})`,
    defence: "Seeded numbers are plausible real Indian mobiles and are refused",
    outcome: seededBlocked ? "Refused as a seeded recipient" : "ACCEPTED — a stranger would be messaged",
    blocked: seededBlocked,
    source: "lib/whatsapp.ts",
  });

  // --- 10. Turn sending on by accident. --------------------------------
  const malformed = "true          -> log instead of sending (safest)";
  const stillDry = isDryRun({ WHATSAPP_DRY_RUN: malformed } as any);
  results.push({
    id: "send-guard-fails-closed",
    attack: "Corrupt WHATSAPP_DRY_RUN so it is no longer the string 'true'",
    defence: "Sending requires an explicit 'false'; anything else logs",
    outcome: stillDry ? "Still dry run" : "LIVE — a malformed value enabled sending",
    blocked: stillDry,
    source: "lib/whatsapp.ts",
  });

  return results;
}
