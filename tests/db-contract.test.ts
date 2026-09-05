import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDb } from "../lib/db/postgres";
import { createMysqlDb } from "../lib/db/mysql";
import type { RecoveryDb } from "../lib/db/types";

/**
 * The dual-database claim, actually exercised.
 *
 * This project says it runs on PostgreSQL and MySQL because Razorpay's own
 * stack uses both. Until this file existed that claim rested entirely on the
 * MySQL implementation compiling — not one of its queries had ever run, which
 * is a strange kind of support to advertise. Every difference between the two
 * dialects here (JSON extraction, `on duplicate key`, datetime literals,
 * `returning` vs a generated id) is a place where "it typechecks" and "it
 * works" come apart.
 *
 * So both drivers run the SAME sequence and are asserted to agree. The
 * contract in lib/db/types.ts is the thing under test, not either
 * implementation:
 *
 *   1. Infrastructure failures throw — they never return null, [] or 0.
 *      Every guardrail is fail-closed, which only works if "the query broke"
 *      is distinguishable from "there is no such row".
 *   2. Duplicate inserts report `{ duplicate: true }` rather than throwing,
 *      normalising Postgres 23505 and MySQL 1062.
 *
 * Skips rather than fails when a database is unreachable, so the suite still
 * runs without Docker. A skipped contract test is honest; a passing one that
 * silently tested nothing is not.
 */

const PG_URL = process.env.TEST_POSTGRES_URL ?? "postgresql://rr:local@127.0.0.1:5433/revenue_recovery";
const MY_URL = process.env.TEST_MYSQL_URL ?? "mysql://root:local@127.0.0.1:3307/revenue_recovery";

/** Namespaced so a run never collides with the seeded demo batch. */
const RUN = `ctr_${Date.now().toString(36)}`;

interface Target {
  name: string;
  db: RecoveryDb | null;
}

const targets: Target[] = [
  { name: "postgres", db: null },
  { name: "mysql", db: null },
];

before(async () => {
  const builders: [string, () => RecoveryDb][] = [
    ["postgres", () => createPostgresDb(PG_URL)],
    ["mysql", () => createMysqlDb(MY_URL)],
  ];

  for (const [name, build] of builders) {
    const target = targets.find((t) => t.name === name)!;
    try {
      const db = build();
      await db.ping();
      target.db = db;
    } catch {
      target.db = null; // unreachable — the tests below skip
    }
  }
});

/**
 * Everything this file writes is removed again.
 *
 * These tests run against the same databases the dashboard reads, so leaving
 * rows behind would quietly move the demo's numbers — the first run added
 * twelve events to a four-hundred-event batch and the recovery rate shifted
 * with it. Test data that survives the test is indistinguishable from real
 * data to every query downstream.
 *
 * Deleted child-first because of the foreign keys, and matched on the run
 * prefix rather than on a timestamp so a crashed earlier run is swept up too.
 */
async function cleanup(url: string, driver: "postgres" | "mysql") {
  /**
   * Matched on the bare `ctr` prefix rather than an escaped `ctr\_`.
   *
   * `_` is a single-character wildcard in LIKE, and escaping it correctly
   * through a TypeScript string into two different SQL dialects is exactly
   * the sort of quoting puzzle that ends with a delete matching more than it
   * reads. Nothing else in this schema begins with "ctr" — the prefix exists
   * only for these tests — so the simple pattern is both correct and
   * obviously correct, which matters more in a cleanup routine.
   */
  const MATCH = "like 'ctr%'";

  const statements = [
    `delete from outcomes where revenue_event_id in (select id from revenue_events where razorpay_event_id ${MATCH})`,
    `delete from recovery_actions where agent_decision_id in (select id from agent_decisions where revenue_event_id in (select id from revenue_events where razorpay_event_id ${MATCH}))`,
    `delete from experiment_assignments where revenue_event_id in (select id from revenue_events where razorpay_event_id ${MATCH})`,
    `delete from agent_decisions where revenue_event_id in (select id from revenue_events where razorpay_event_id ${MATCH})`,
    `delete from audit_log where revenue_event_id in (select id from revenue_events where razorpay_event_id ${MATCH})`,
    `delete from revenue_events where razorpay_event_id ${MATCH}`,
    `delete from customer_consent where customer_id ${MATCH}`,
    `delete from decision_cache where cache_key ${MATCH}`,
  ];

  if (driver === "postgres") {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    try {
      for (const sql of statements) await pool.query(sql);
    } finally {
      await pool.end();
    }
    return;
  }

  const mysql = (await import("mysql2/promise")).default;
  const conn = await mysql.createConnection(url);
  try {
    // MySQL cannot delete from a table it selects from in a subquery, so the
    // ids are resolved first and passed in.
    const [rows] = await conn.query<any[]>(
      `select id from revenue_events where razorpay_event_id ${MATCH}`
    );
    const ids = rows.map((r: any) => r.id);
    if (ids.length) {
      const list = ids.map((i: string) => conn.escape(i)).join(",");
      const [decisions] = await conn.query<any[]>(
        `select id from agent_decisions where revenue_event_id in (${list})`
      );
      const decisionIds = decisions.map((d: any) => d.id);
      if (decisionIds.length) {
        await conn.query(
          `delete from recovery_actions where agent_decision_id in (${decisionIds
            .map((i: string) => conn.escape(i))
            .join(",")})`
        );
      }
      await conn.query(`delete from outcomes where revenue_event_id in (${list})`);
      await conn.query(`delete from experiment_assignments where revenue_event_id in (${list})`);
      await conn.query(`delete from agent_decisions where revenue_event_id in (${list})`);
      await conn.query(`delete from audit_log where revenue_event_id in (${list})`);
      await conn.query(`delete from revenue_events where id in (${list})`);
    }
    await conn.query(`delete from customer_consent where customer_id ${MATCH}`);
    await conn.query(`delete from decision_cache where cache_key ${MATCH}`);
  } finally {
    await conn.end();
  }
}

after(async () => {
  for (const t of targets) {
    if (!t.db) continue;
    await cleanup(t.name === "postgres" ? PG_URL : MY_URL, t.name as "postgres" | "mysql").catch(
      (err) => console.error(`[contract] cleanup failed on ${t.name}:`, err?.message ?? err)
    );
    await t.db.close().catch(() => {});
  }
});

/** Runs one assertion body against every reachable driver. */
function forEachDriver(name: string, body: (db: RecoveryDb, driver: string) => Promise<void>) {
  test(name, async (t) => {
    const reachable = targets.filter((x) => x.db);
    if (reachable.length === 0) {
      t.skip("no database reachable — start docker compose to run the contract tests");
      return;
    }
    for (const target of reachable) {
      await body(target.db!, target.name);
    }
  });
}

function eventRow(suffix: string) {
  return {
    razorpay_event_id: `${RUN}_evt_${suffix}`,
    event_type: "payment.failed",
    razorpay_payment_id: `${RUN}_pay_${suffix}`,
    razorpay_order_id: `${RUN}_order_${suffix}`,
    amount_paise: 123400,
    currency: "INR",
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment failed due to insufficient funds in the account.",
    payment_method: "card",
    customer_id: `${RUN}_cust_${suffix}`,
    customer_contact: "+919000000001",
    raw_payload: { event: "payment.failed", marker: RUN },
  };
}

async function newEvent(db: RecoveryDb, suffix: string): Promise<string> {
  const inserted = await db.insertRevenueEvent(eventRow(suffix));
  assert.ok(!("duplicate" in inserted), "first insert must not report a duplicate");
  return (inserted as { id: string }).id;
}

// --- the contract -----------------------------------------------------------

forEachDriver("reports its own driver name and reaches every table", async (db, driver) => {
  assert.equal(db.driver, driver);
  const missing = await db.missingTables();
  assert.deepEqual(missing, [], `${driver} is missing tables: ${missing.join(", ")}`);
});

forEachDriver("a duplicate event is reported, not thrown", async (db, driver) => {
  // Webhook retries are normal traffic. The two engines signal this
  // differently (23505 vs 1062) and both must arrive here as the same shape.
  const row = eventRow(`dup_${driver}`);
  const first = await db.insertRevenueEvent(row);
  assert.ok(!("duplicate" in first), `${driver}: first insert`);

  const second = await db.insertRevenueEvent(row);
  assert.deepEqual(second, { duplicate: true }, `${driver}: second insert`);
});

forEachDriver("an event round-trips by event id, payment id and payload", async (db, driver) => {
  const id = await newEvent(db, `rt_${driver}`);

  assert.equal(await db.findEventIdByRazorpayEventId(`${RUN}_evt_rt_${driver}`), id);
  assert.equal(await db.findEventIdByPaymentId(`${RUN}_pay_rt_${driver}`), id);

  // The resume path depends on this being the payload that CREATED the row.
  const payload = await db.getStoredPayload(id);
  assert.equal(payload?.marker, RUN, `${driver}: stored payload`);
});

forEachDriver("an unknown id is null, not an error and not a stray row", async (db, driver) => {
  assert.equal(await db.findEventIdByRazorpayEventId(`${RUN}_nope`), null, driver);
  assert.equal(await db.findEventIdByPaymentId(`${RUN}_nope`), null, driver);
  assert.equal(await db.getStoredPayload("00000000-0000-4000-8000-000000000000"), null, driver);
});

forEachDriver("consent upserts idempotently and reads back", async (db, driver) => {
  const customer = `${RUN}_consent_${driver}`;

  await db.upsertConsent([
    { customer_id: customer, dnd: true, whatsapp_opt_in: false, email_opt_in: false },
  ]);
  assert.deepEqual(await db.getConsent(customer), { dnd: true }, `${driver}: first write`);

  // Re-seeding a batch must not duplicate or drift.
  await db.upsertConsent([
    { customer_id: customer, dnd: false, whatsapp_opt_in: true, email_opt_in: true },
  ]);
  assert.deepEqual(await db.getConsent(customer), { dnd: false }, `${driver}: upsert`);
});

forEachDriver("an unknown customer has no consent row rather than a default", async (db, driver) => {
  // The webhook refuses when this is null. Returning a falsy object instead
  // would read as "opted in" and quietly defeat the one rule with no
  // exceptions.
  assert.equal(await db.getConsent(`${RUN}_never_seen`), null, driver);
});

forEachDriver("stopping rules come back oldest first", async (db, driver) => {
  // bucketOutcomes and the replay fidelity check both treat the FIRST row for
  // an event as the one that stopped it. Without an ORDER BY the engine
  // returns rows plan-dependently, and a retried webhook — which writes a
  // second stopping rule — would be attributed to whichever row came back
  // first, differently on consecutive queries.
  const id = await newEvent(db, `order_${driver}`);

  await db.insertAudit(id, "stopping_rule_triggered", { reason: "customer_dnd_opt_out" });
  await new Promise((r) => setTimeout(r, 25));
  await db.insertAudit(id, "stopping_rule_triggered", { reason: "negative_expected_value" });

  const mine = (await db.listStoppingRules()).filter((s) => s.revenue_event_id === id);

  assert.equal(mine.length, 2, `${driver}: both rows returned`);
  assert.equal(mine[0].reason, "customer_dnd_opt_out", `${driver}: earliest first`);
});

forEachDriver("a per-event audit trail reads forwards", async (db, driver) => {
  const id = await newEvent(db, `trace_${driver}`);

  await db.insertAudit(id, "event_received", { step: 1 });
  await new Promise((r) => setTimeout(r, 25));
  await db.insertAudit(id, "classified", { step: 2 });

  const rows = await db.listAuditForEvent(id);
  assert.equal(rows.length, 2, driver);
  assert.equal(rows[0].stage, "event_received", `${driver}: oldest first`);
  assert.equal(rows[1].detail.step, 2, `${driver}: detail survives the round trip`);
});

forEachDriver("the cooldown window is bounded at both ends", async (db, driver) => {
  const id = await newEvent(db, `cool_${driver}`);
  const customer = `${RUN}_cust_cool_${driver}`;
  await db.setClassification(id, "insufficient_funds", new Date().toISOString());

  const decision = await db.insertDecision({
    revenue_event_id: id,
    root_cause: "insufficient_funds",
    chosen_action: "send_retry_link_whatsapp",
    rationale: "contract test",
    bounded_by: [],
  });

  const sentAt = new Date("2026-06-15T12:00:00.000Z").toISOString();
  await db.insertRecoveryAction({
    agent_decision_id: decision.id,
    channel: "whatsapp",
    action_type: "retry_link_sent",
    status: "sent",
    attempt_number: 1,
    executed_at: sentAt,
  });

  // The event this action belongs to carries the customer id, so query by it.
  const eventCustomer = eventRow(`cool_${driver}`).customer_id;

  const inWindow = await db.hasActionForCustomerSince(
    eventCustomer,
    "2026-06-15T08:00:00.000Z",
    "2026-06-15T16:00:00.000Z"
  );
  assert.equal(inWindow, true, `${driver}: a send inside the window is found`);

  // A send AFTER the event cannot have caused it to be held back.
  const afterOnly = await db.hasActionForCustomerSince(
    eventCustomer,
    "2026-06-15T06:00:00.000Z",
    "2026-06-15T10:00:00.000Z"
  );
  assert.equal(afterOnly, false, `${driver}: upper bound excludes later sends`);

  void customer;
});

forEachDriver("decision memoisation round-trips", async (db, driver) => {
  const key = `${RUN}|${driver}|band|attempts:0`;

  assert.equal(await db.getCachedDecision(key), null, `${driver}: cold`);

  await db.putCachedDecision({
    cache_key: key,
    chosen_action: "send_retry_link_whatsapp",
    rationale: "Reuse me.",
    model: "contract-test",
  });

  const cached = await db.getCachedDecision(key);
  assert.equal(cached?.chosen_action, "send_retry_link_whatsapp", driver);
  assert.equal(cached?.rationale, "Reuse me.", driver);

  // Idempotent: a second write for the same situation must not throw.
  await db.putCachedDecision({
    cache_key: key,
    chosen_action: "send_retry_link_whatsapp",
    rationale: "Reuse me.",
    model: "contract-test",
  });
});

forEachDriver("a duplicate experiment assignment is reported, not thrown", async (db, driver) => {
  // A retried webhook must never flip or double-count an arm — that would
  // corrupt both denominators of the measured lift at once.
  const id = await newEvent(db, `arm_${driver}`);
  const row = {
    revenue_event_id: id,
    arm: "treated",
    policy_version: "contract",
    recovery_probability: 0.42,
    expected_value_paise: 1000,
  };

  const first = await db.insertAssignment(row);
  assert.ok(!("duplicate" in first), `${driver}: first`);
  assert.deepEqual(await db.insertAssignment(row), { duplicate: true }, `${driver}: second`);

  const mine = (await db.listAssignments()).find((a) => a.revenue_event_id === id);
  assert.equal(mine?.arm, "treated", driver);
  // Numeric columns come back as strings on both engines often enough that
  // the driver has to coerce them; a NaN here silently breaks replay.
  assert.equal(typeof mine?.recovery_probability, "number", `${driver}: probability is numeric`);
  assert.ok(Math.abs((mine!.recovery_probability as number) - 0.42) < 1e-6, driver);
});

forEachDriver("a duplicate outcome is reported, not thrown", async (db, driver) => {
  const id = await newEvent(db, `out_${driver}`);
  const row = {
    revenue_event_id: id,
    recovered: true,
    recovered_amount_paise: 123400,
    recovered_payment_id: `${RUN}_recovered_${driver}`,
    attribution_window_minutes: 1440,
    resolved_at: new Date().toISOString(),
  };

  const first = await db.insertOutcome(row);
  assert.ok(!("duplicate" in first), `${driver}: first`);
  assert.deepEqual(await db.insertOutcome(row), { duplicate: true }, `${driver}: second`);
});

forEachDriver("a recovery finds the failure it belongs to", async (db, driver) => {
  const id = await newEvent(db, `attr_${driver}`);
  const found = await db.findLatestFailedEventByOrderId(`${RUN}_order_attr_${driver}`);

  assert.equal(found?.id, id, driver);
  assert.ok(found?.received_at, `${driver}: received_at is needed to time the recovery`);
  assert.ok(
    !Number.isNaN(new Date(found!.received_at).getTime()),
    `${driver}: received_at parses`
  );
});

forEachDriver("simulated links are excluded from the live-link count", async (db, driver) => {
  // The test-mode budget rations REAL links; counting simulated ones would
  // exhaust a budget that was never spent.
  const before = await db.countLiveLinks();

  const id = await newEvent(db, `link_${driver}`);
  const decision = await db.insertDecision({
    revenue_event_id: id,
    root_cause: "insufficient_funds",
    chosen_action: "send_retry_link_whatsapp",
    rationale: "contract test",
    bounded_by: [],
  });

  await db.insertRecoveryAction({
    agent_decision_id: decision.id,
    channel: "whatsapp",
    action_type: "retry_link_sent",
    status: "simulated",
    attempt_number: 1,
    razorpay_payment_link_id: `simulated_${id.slice(0, 8)}`,
  });

  assert.equal(await db.countLiveLinks(), before, `${driver}: simulated does not count`);

  await db.insertRecoveryAction({
    agent_decision_id: decision.id,
    channel: "whatsapp",
    action_type: "retry_link_sent",
    status: "sent",
    attempt_number: 2,
    razorpay_payment_link_id: `plink_${RUN}_${driver}`,
  });

  assert.equal(await db.countLiveLinks(), before + 1, `${driver}: a real link counts`);
});

forEachDriver("retry history and attempt counts agree with what was written", async (db, driver) => {
  const id = await newEvent(db, `hist_${driver}`);
  const customer = eventRow(`hist_${driver}`).customer_id!;

  assert.equal(await db.countActionsForEvent(id), 0, `${driver}: cold`);

  const decision = await db.insertDecision({
    revenue_event_id: id,
    root_cause: "insufficient_funds",
    chosen_action: "send_retry_link_email",
    rationale: "contract test",
    bounded_by: [],
  });

  await db.insertRecoveryAction({
    agent_decision_id: decision.id,
    channel: "email",
    action_type: "retry_link_sent",
    status: "sent",
    attempt_number: 1,
  });

  assert.equal(await db.countActionsForEvent(id), 1, driver);

  const history = await db.getCustomerRetryHistory(customer, 10);
  assert.equal(history.length, 1, driver);
  assert.equal(history[0].channel, "email", driver);
  assert.equal(typeof history[0].attempt_number, "number", `${driver}: numeric attempt`);
});

forEachDriver("a dispute flag is visible to the kill-switch", async (db, driver) => {
  const id = await newEvent(db, `disp_${driver}`);

  assert.equal(await db.hasDisputeFlag(id), false, `${driver}: cold`);
  await db.insertAudit(id, "stopping_rule_triggered", { reason: "refund_or_dispute" });
  assert.equal(await db.hasDisputeFlag(id), true, `${driver}: after the flag`);
});

forEachDriver("the two drivers agree on the shape of a listed event", async (db, driver) => {
  const id = await newEvent(db, `shape_${driver}`);
  await db.setClassification(id, "card_declined", new Date().toISOString());

  const byId = await db.listEventsByIds([id]);
  assert.equal(byId.length, 1, driver);
  assert.equal(byId[0].root_cause, "card_declined", driver);
  assert.equal(typeof byId[0].amount_paise, "number", `${driver}: amount is numeric`);

  const listed = (await db.listEvents()).find((e) => e.id === id);
  assert.ok(listed, `${driver}: appears in listEvents`);
  assert.equal(typeof listed!.amount_paise, "number", `${driver}: amount is numeric`);
  assert.ok(listed!.received_at, `${driver}: carries received_at`);
});

forEachDriver("an empty id list returns nothing rather than everything", async (db, driver) => {
  // A naive `in ()` build can degrade to "no filter", which would hand the
  // dashboard the entire table.
  assert.deepEqual(await db.listEventsByIds([]), [], driver);
});

forEachDriver("a single event's decision and outcome are fetched directly", async (db, driver) => {
  // These replaced a full-table load that pulled every decision in the batch
  // to use one of them.
  const id = await newEvent(db, `single_${driver}`);

  assert.equal(await db.findDecisionForEvent(id), null, `${driver}: no decision yet`);
  assert.equal(await db.findOutcomeForEvent(id), null, `${driver}: no outcome yet`);

  await db.insertDecision({
    revenue_event_id: id,
    root_cause: "insufficient_funds",
    chosen_action: "send_retry_link_whatsapp",
    rationale: "contract test",
    bounded_by: [],
  });

  const decision = await db.findDecisionForEvent(id);
  assert.equal(decision?.chosen_action, "send_retry_link_whatsapp", driver);
  assert.equal(decision?.rationale, "contract test", driver);

  await db.insertOutcome({
    revenue_event_id: id,
    recovered: true,
    recovered_amount_paise: 4321,
    recovered_payment_id: `${RUN}_single_${driver}`,
    attribution_window_minutes: 1440,
    resolved_at: new Date().toISOString(),
  });

  const outcome = await db.findOutcomeForEvent(id);
  assert.equal(outcome?.recovered, true, driver);
  assert.equal(outcome?.recovered_amount_paise, 4321, `${driver}: amount is numeric`);
  assert.ok(outcome?.resolved_at, `${driver}: resolved_at survives`);
});

forEachDriver("a resumed event's FIRST decision is the one returned", async (db, driver) => {
  // A resumed delivery can write a second decision. The first is the one that
  // governed the action actually taken, so it is the one the trace must show.
  const id = await newEvent(db, `twodec_${driver}`);

  await db.insertDecision({
    revenue_event_id: id,
    root_cause: "insufficient_funds",
    chosen_action: "send_retry_link_whatsapp",
    rationale: "first",
    bounded_by: [],
  });
  await new Promise((r) => setTimeout(r, 25));
  await db.insertDecision({
    revenue_event_id: id,
    root_cause: "insufficient_funds",
    chosen_action: "escalate_human",
    rationale: "second",
    bounded_by: [],
  });

  assert.equal((await db.findDecisionForEvent(id))?.rationale, "first", driver);
});

forEachDriver("a second decision for the same event is refused atomically", async (db, driver) => {
  // The webhook's "has this been decided?" check is a read followed by a
  // write, and two concurrent redeliveries can interleave between them. That
  // happened against real Razorpay traffic: both saw no decision, both
  // proceeded, and one customer received two payment links four seconds
  // apart. Only the constraint closes that window.
  const id = await newEvent(db, `race_${driver}`);

  const row = {
    revenue_event_id: id,
    root_cause: "gateway_error",
    chosen_action: "send_retry_link_whatsapp",
    rationale: "first",
    bounded_by: [],
  };

  const first = await db.insertDecision(row);
  assert.ok(!first.duplicate, `${driver}: the first decision is recorded`);

  const second = await db.insertDecision({ ...row, rationale: "second" });
  assert.equal(second.duplicate, true, `${driver}: the second is refused`);
  assert.equal(second.id, first.id, `${driver}: it returns the winner's id`);

  // And only one decision exists, whichever raced.
  const stored = await db.findDecisionForEvent(id);
  assert.equal(stored?.rationale, "first", `${driver}: the first decision stands`);
});

forEachDriver("two simultaneous decisions leave exactly one", async (db, driver) => {
  // The sequential test above passes even without a constraint. This one
  // does not: it fires both inserts before either resolves.
  const id = await newEvent(db, `parallel_${driver}`);
  const row = {
    revenue_event_id: id,
    root_cause: "gateway_error",
    chosen_action: "send_retry_link_whatsapp",
    rationale: "concurrent",
    bounded_by: [],
  };

  const results = await Promise.all([
    db.insertDecision(row),
    db.insertDecision(row),
    db.insertDecision(row),
  ]);

  const winners = results.filter((r) => !r.duplicate);
  assert.equal(winners.length, 1, `${driver}: exactly one insert wins`);
  assert.equal(
    new Set(results.map((r) => r.id)).size,
    1,
    `${driver}: all three report the same decision id`
  );
});
