import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchDueActions, type DispatcherDb } from "../lib/dispatcher";
import type { DueAction } from "../lib/db/types";

/**
 * The scheduled-send dispatcher, with the database faked and the clock passed
 * in.
 *
 * The properties worth asserting are all about what happens when something
 * goes wrong at the boundary — two ticks racing, a send failing, the queue
 * running late into quiet hours. None of them are reachable by calling the
 * happy path twice.
 */

function due(overrides: Partial<DueAction> = {}): DueAction {
  return {
    id: "act_1",
    revenue_event_id: "evt_1",
    agent_decision_id: "dec_1",
    channel: "whatsapp",
    attempt_number: 1,
    scheduled_for: "2026-09-05T13:30:00.000Z", // 19:00 IST
    amount_paise: 250000,
    currency: "INR",
    customer_contact: "+919000000001",
    ...overrides,
  };
}

interface Recorder {
  db: DispatcherDb;
  claims: string[];
  completed: any[];
  audits: any[];
}

function fakes(
  rows: DueAction[],
  options: { claimWins?: boolean } = {}
): Recorder & { deps: any } {
  const claims: string[] = [];
  const completed: any[] = [];
  const audits: any[] = [];

  const db: DispatcherDb = {
    async listDueActions() {
      return rows;
    },
    async claimDueAction(id) {
      claims.push(id);
      return options.claimWins ?? true;
    },
    async completeDueAction(update) {
      completed.push(update);
    },
    async countLiveLinks() {
      return 0;
    },
  };

  return {
    db,
    claims,
    completed,
    audits,
    deps: {
      db,
      audit: async (eventId: string, stage: string, detail: any) => {
        audits.push({ eventId, stage, detail });
      },
    },
  };
}

const AT_1900_IST = () => new Date("2026-09-05T13:35:00.000Z");

test("a due send creates a link and goes out", async () => {
  const f = fakes([due()]);

  const summary = await dispatchDueActions({
    ...f.deps,
    now: AT_1900_IST,
    createLink: async () => ({
      paymentLinkId: "plink_real",
      shortUrl: "https://rzp.io/x",
      status: "created",
    }),
    sendWhatsApp: async () => ({ success: true, messageId: "wamid.SENT", status: "accepted" }),
  });

  assert.equal(summary.sent, 1);
  assert.equal(f.completed[0].status, "sent");
  assert.equal(f.completed[0].razorpay_payment_link_id, "plink_real");
  // Captured so Meta's later delivery callback has something to join on.
  assert.equal(f.completed[0].provider_message_id, "wamid.SENT");
  // Meta's word, not ours — `accepted` is weaker than delivered.
  assert.equal(f.completed[0].delivery_state, "accepted");
});

test("losing the claim is not a failure", async () => {
  // Another tick is handling this row. Counting it as an error would make
  // ordinary overlap look like breakage.
  const f = fakes([due()], { claimWins: false });

  const summary = await dispatchDueActions({
    ...f.deps,
    now: AT_1900_IST,
    createLink: async () => {
      throw new Error("must not be reached — the claim was lost");
    },
    sendWhatsApp: async () => ({ success: true }),
  });

  assert.equal(summary.skipped_claimed, 1);
  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 0);
  assert.equal(f.completed.length, 0, "nothing is written for a row we did not claim");
});

test("the claim is taken before anything is created or sent", async () => {
  const order: string[] = [];
  const f = fakes([due()]);

  await dispatchDueActions({
    db: {
      ...f.db,
      async claimDueAction(id) {
        order.push("claim");
        return true;
      },
    },
    audit: f.deps.audit,
    now: AT_1900_IST,
    createLink: async () => {
      order.push("link");
      return { paymentLinkId: "plink", shortUrl: "u", status: "created" };
    },
    sendWhatsApp: async () => {
      order.push("send");
      return { success: true };
    },
  });

  assert.deepEqual(order, ["claim", "link", "send"]);
});

test("a queue running late into quiet hours holds rather than sends", async () => {
  /**
   * The row was scheduled for 20:55 IST and the tick reaches it at 21:05.
   * Having been allowed when it was queued is not a licence to send now.
   */
  const f = fakes([due({ scheduled_for: "2026-09-05T15:25:00.000Z" })]);

  const summary = await dispatchDueActions({
    ...f.deps,
    now: () => new Date("2026-09-05T15:35:00.000Z"), // 21:05 IST
    createLink: async () => {
      throw new Error("must not be reached inside quiet hours");
    },
    sendWhatsApp: async () => ({ success: true }),
  });

  assert.equal(summary.held_quiet_hours, 1);
  assert.equal(summary.sent, 0);
  assert.equal(f.claims.length, 0, "an unheld row is not even claimed");
});

test("a send that fails stays claimed rather than retrying forever", async () => {
  /**
   * Releasing the row would put it straight back into the next tick's batch,
   * and an unreachable recipient would be retried every five minutes for
   * ever — the retry ceiling counts decisions, not dispatch attempts, so
   * nothing downstream would stop it.
   */
  const f = fakes([due()]);

  const summary = await dispatchDueActions({
    ...f.deps,
    now: AT_1900_IST,
    createLink: async () => {
      throw new Error("razorpay unreachable");
    },
    sendWhatsApp: async () => ({ success: true }),
  });

  assert.equal(summary.failed, 1);
  assert.equal(f.completed[0].status, "failed");
  assert.equal(f.completed[0].action_id, "act_1");

  const audit = f.audits.find((a) => a.stage === "action_executed");
  assert.equal(audit.detail.delivery_success, false);
  assert.match(audit.detail.error, /razorpay unreachable/);
});

test("one failing row does not stop the rest of the batch", async () => {
  const f = fakes([due({ id: "act_1" }), due({ id: "act_2", revenue_event_id: "evt_2" })]);

  let calls = 0;
  const summary = await dispatchDueActions({
    ...f.deps,
    now: AT_1900_IST,
    createLink: async () => {
      calls += 1;
      if (calls === 1) throw new Error("first one broke");
      return { paymentLinkId: "plink_2", shortUrl: "u", status: "created" };
    },
    sendWhatsApp: async () => ({ success: true, messageId: "wamid.2", status: "accepted" }),
  });

  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 1);
});

test("the audit row says how late the queue was", async () => {
  // A scheduler whose lag is invisible is a scheduler nobody can tell has
  // stopped.
  const f = fakes([due({ scheduled_for: "2026-09-05T13:30:00.000Z" })]);

  await dispatchDueActions({
    ...f.deps,
    now: () => new Date("2026-09-05T13:34:00.000Z"), // four minutes late
    createLink: async () => ({ paymentLinkId: "p", shortUrl: "u", status: "created" }),
    sendWhatsApp: async () => ({ success: true }),
  });

  const audit = f.audits.find((a) => a.stage === "action_executed");
  assert.equal(audit.detail.lag_seconds, 240);
  assert.equal(audit.detail.dispatched_from, "scheduled_queue");
});

test("an empty queue is a clean no-op", async () => {
  const f = fakes([]);
  const summary = await dispatchDueActions({ ...f.deps, now: AT_1900_IST });
  assert.deepEqual(summary, {
    due: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    skipped_claimed: 0,
    held_quiet_hours: 0,
  });
});
