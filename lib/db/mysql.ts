import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import type {
  AssignmentInsert,
  AuditRow,
  DecisionInsert,
  DeliveryStatusUpdate,
  DispatchResult,
  DueAction,
  DecisionRow,
  InsertResult,
  OutcomeInsert,
  RecoveryActionInsert,
  RecoveryActionRow,
  RecoveryDb,
  RetryAttempt,
  RevenueEventInsert,
  RevenueEventRow,
} from "./types";

/**
 * MySQL implementation — also covers TiDB, which speaks the MySQL protocol.
 *
 * Four differences from the Postgres implementation are worth knowing, since
 * they are where a naive port would silently misbehave:
 *
 * 1. **Ids are generated in the application.** MySQL has no
 *    `gen_random_uuid()` default and no `RETURNING`, so there is no way to
 *    learn the id of a row you just inserted without a second round trip.
 *    Generating the UUID here makes the insert single-shot and keeps ids in
 *    the same format as the Postgres schema.
 * 2. **Unique violations are `ER_DUP_ENTRY` (1062)**, not `23505`.
 * 3. **JSON containment has no `@>` operator**, so the dispute kill-switch
 *    uses `JSON_UNQUOTE(JSON_EXTRACT(...))` instead.
 * 4. **`bounded_by` is JSON, not a text array** — MySQL has no array type.
 *
 * As in the Postgres implementation, infrastructure errors propagate rather
 * than degrading into a falsy result, because every guardrail above depends
 * on telling failure apart from absence.
 */

const DUPLICATE_ENTRY = 1062;

const TABLES = [
  "revenue_events",
  "agent_decisions",
  "recovery_actions",
  "outcomes",
  "customer_consent",
  "audit_log",
  "experiment_assignments",
  "decision_cache",
  // Not written by the pipeline, but preflight should fail loudly on a
  // database that predates it: a missing table here means the shared rate
  // limiter silently degrades to a per-instance counter.
  "rate_limit_windows",
];

/** MySQL DATETIME comes back as a Date; the pipeline speaks ISO strings. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

/** MySQL has no boolean type — TINYINT(1) arrives as 0/1. */
function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** DATETIME columns won't accept an ISO string with a trailing 'Z'. */
function toMysqlDatetime(isoString: string): string {
  return new Date(isoString).toISOString().slice(0, 19).replace("T", " ");
}

export function createMysqlDb(connectionUri: string): RecoveryDb {
  const pool = mysql.createPool({
    uri: connectionUri,
    // Per-process, and serverless has many processes — see the note in
    // postgres.ts. Five per lambda exhausts a managed instance's connection
    // limit under concurrency, and the resulting query failures land on the
    // fail-closed guardrails, so a traffic spike would look like the agent
    // deciding to stop acting.
    connectionLimit:
      process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? 1 : 5,
    connectTimeout: 10_000,
    // TiDB Serverless and most managed MySQL require TLS.
    ssl: /localhost|127\.0\.0\.1/.test(connectionUri)
      ? undefined
      : { rejectUnauthorized: false },
    timezone: "Z",
  });

  const query = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
    const [rows] = await pool.query(sql, params);
    return rows as T[];
  };

  const exec = async (sql: string, params: any[] = []): Promise<void> => {
    await pool.execute(sql, params);
  };

  /**
   * How many rows an UPDATE actually touched.
   *
   * MySQL has no RETURNING, so a conditional update — the shape used for
   * claiming a scheduled send exactly once — can only be checked by asking
   * the result header. Postgres answers the same question with
   * `returning id`; both callers get a boolean and never learn which.
   */
  const affected = async (sql: string, params: any[] = []): Promise<number> => {
    const [result] = await pool.execute(sql, params);
    return Number((result as any)?.affectedRows ?? 0);
  };

  const insertOrDuplicate = async (
    sql: string,
    params: any[],
    id: string
  ): Promise<InsertResult> => {
    try {
      await pool.execute(sql, params);
      return { id };
    } catch (err: any) {
      if (err?.errno === DUPLICATE_ENTRY) return { duplicate: true };
      throw err;
    }
  };

  return {
    driver: "mysql",

    async ping() {
      await query("select 1");
    },

    async missingTables() {
      const rows = await query<{ TABLE_NAME: string; table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = database()`
      );
      const present = new Set(
        rows.map((r) => String(r.table_name ?? r.TABLE_NAME).toLowerCase())
      );
      return TABLES.filter((t) => !present.has(t));
    },

    async close() {
      await pool.end();
    },

    // --- ingestion

    async findEventIdByRazorpayEventId(razorpayEventId) {
      const rows = await query<{ id: string }>(
        "select id from revenue_events where razorpay_event_id = ? limit 1",
        [razorpayEventId]
      );
      return rows[0]?.id ?? null;
    },

    async findEventIdByPaymentId(razorpayPaymentId) {
      const rows = await query<{ id: string }>(
        `select id from revenue_events
          where razorpay_payment_id = ?
          order by received_at desc limit 1`,
        [razorpayPaymentId]
      );
      return rows[0]?.id ?? null;
    },

    async getStoredPayload(revenueEventId) {
      const rows = await query<{ raw_payload: any }>(
        "select raw_payload from revenue_events where id = ? limit 1",
        [revenueEventId]
      );
      const raw = rows[0]?.raw_payload;
      // mysql2 parses JSON columns already; a string means it did not.
      return typeof raw === "string" ? JSON.parse(raw) : (raw ?? null);
    },

    async insertRevenueEvent(row: RevenueEventInsert) {
      const id = randomUUID();
      return insertOrDuplicate(
        `insert into revenue_events
           (id, razorpay_event_id, event_type, razorpay_payment_id, razorpay_order_id,
            amount_paise, currency, error_code, error_description, payment_method,
            customer_id, customer_contact, raw_payload, received_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?, coalesce(?, current_timestamp(3)))`,
        [
          id,
          row.razorpay_event_id,
          row.event_type,
          row.razorpay_payment_id,
          row.razorpay_order_id,
          row.amount_paise,
          row.currency,
          row.error_code,
          row.error_description,
          row.payment_method,
          row.customer_id,
          row.customer_contact,
          JSON.stringify(row.raw_payload),
          // MySQL will not parse an ISO string with a trailing Z into
          // datetime(3); hand it the format the column expects.
          row.received_at ? row.received_at.replace("T", " ").replace("Z", "") : null,
        ],
        id
      );
    },

    async setClassification(eventId, rootCause, processedAt) {
      await exec(
        "update revenue_events set root_cause = ?, processed_at = ? where id = ?",
        [rootCause, toMysqlDatetime(processedAt), eventId]
      );
    },

    // --- audit

    async insertAudit(revenueEventId, stage, detail) {
      await exec(
        "insert into audit_log (id, revenue_event_id, stage, detail) values (?,?,?,?)",
        [randomUUID(), revenueEventId, stage, JSON.stringify(detail)]
      );
    },

    // --- guardrails

    async getConsent(customerId) {
      const rows = await query<{ dnd: number }>(
        "select dnd from customer_consent where customer_id = ? limit 1",
        [customerId]
      );
      return rows[0] ? { dnd: bool(rows[0].dnd) } : null;
    },

    async countActionsForEvent(revenueEventId) {
      const rows = await query<{ count: number }>(
        `select count(*) as count
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
          where ad.revenue_event_id = ?`,
        [revenueEventId]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async hasActionForCustomerSince(customerId, sinceIso, untilIso) {
      const rows = await query(
        `select 1 as hit
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
           join revenue_events re on re.id = ad.revenue_event_id
          where re.customer_id = ?
            and ra.executed_at >= ?
            and ra.executed_at <= ?
          limit 1`,
        [customerId, toMysqlDatetime(sinceIso), toMysqlDatetime(untilIso)]
      );
      return rows.length > 0;
    },

    async getEventPaymentId(revenueEventId) {
      const rows = await query<{ razorpay_payment_id: string | null }>(
        "select razorpay_payment_id from revenue_events where id = ? limit 1",
        [revenueEventId]
      );
      if (rows.length === 0) throw new Error(`No revenue_event ${revenueEventId}`);
      return rows[0].razorpay_payment_id;
    },

    async hasDisputeFlag(revenueEventId) {
      // No jsonb containment operator in MySQL — extract and compare.
      const rows = await query(
        `select 1 as hit from audit_log
          where revenue_event_id = ?
            and stage = 'stopping_rule_triggered'
            and JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reason')) = 'refund_or_dispute'
          limit 1`,
        [revenueEventId]
      );
      return rows.length > 0;
    },

    // --- agent + execution

    async countDecisionsForEvent(revenueEventId) {
      const rows = await query<{ count: number }>(
        "select count(*) as count from agent_decisions where revenue_event_id = ?",
        [revenueEventId]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async insertDecision(row: DecisionInsert) {
      const id = randomUUID();
      try {
        await exec(
        `insert into agent_decisions
           (id, revenue_event_id, root_cause, chosen_action, rationale, bounded_by, from_cache, cache_key)
         values (?,?,?,?,?,?,?,?)`,
        [
          id,
          row.revenue_event_id,
          row.root_cause,
          row.chosen_action,
          row.rationale,
          JSON.stringify(row.bounded_by),
            row.from_cache ? 1 : 0,
            row.cache_key ?? null,
          ]
        );
      } catch (err: any) {
        // 1062 is MySQL's unique violation — another delivery decided first.
        if (err?.errno !== 1062) throw err;
        const existing = await query<{ id: string }>(
          "select id from agent_decisions where revenue_event_id = ? order by decided_at asc limit 1",
          [row.revenue_event_id]
        );
        return { id: existing[0].id, duplicate: true };
      }
      return { id };
    },

    // --- decision memoisation

    async getCachedDecision(cacheKey) {
      const rows = await query<any>(
        "select chosen_action, rationale, model from decision_cache where cache_key = ?",
        [cacheKey]
      );
      return rows[0] ?? null;
    },

    async putCachedDecision(row) {
      // Two events with the same situation can race; whichever lands first
      // wins and the other reuses it. Identical inputs, identical answer.
      await exec(
        `insert into decision_cache (cache_key, chosen_action, rationale, model)
         values (?,?,?,?)
         on duplicate key update cache_key = cache_key`,
        [row.cache_key, row.chosen_action, row.rationale, row.model]
      );
    },

    async countCachedDecisions() {
      const rows = await query<{ count: number }>(
        "select count(*) as count from decision_cache"
      );
      return Number(rows[0]?.count ?? 0);
    },

    async insertRecoveryAction(row: RecoveryActionInsert) {
      await exec(
        `insert into recovery_actions
           (id, agent_decision_id, channel, action_type, status, attempt_number,
            razorpay_payment_link_id, executed_at, provider_message_id,
            delivery_state, scheduled_for)
         values (?,?,?,?,?,?,?, coalesce(?, current_timestamp(3)), ?, ?, ?)`,
        [
          randomUUID(),
          row.agent_decision_id,
          row.channel,
          row.action_type,
          row.status,
          row.attempt_number,
          row.razorpay_payment_link_id ?? null,
          row.executed_at ? toMysqlDatetime(row.executed_at) : null,
          row.provider_message_id ?? null,
          row.delivery_state ?? null,
          row.scheduled_for ? toMysqlDatetime(row.scheduled_for) : null,
        ]
      );
    },

    async recordDeliveryStatus(update: DeliveryStatusUpdate) {
      /**
       * The provider's later word replaces ours, but only downward — see the
       * note on the Postgres implementation. `affectedRows` counts matched
       * rows here rather than changed ones, which is what this needs: a
       * repeated `delivered` callback for the same message is a match, not a
       * miss, and reporting it as unmatched would make Meta's normal retry
       * behaviour look like a bug.
       */
      // Two statements because MySQL has no RETURNING and this needs a column
      // from the joined table. The lookup runs first: if it finds nothing
      // there is no row to update and no event to file the status against.
      const found = await query<any>(
        `select ad.revenue_event_id
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
          where ra.provider_message_id = ?
          limit 1`,
        [update.provider_message_id]
      );
      if (found.length === 0) return null;

      await exec(
        `update recovery_actions
            set delivery_state = ?,
                delivery_state_at = ?,
                delivery_error = ?,
                status = case
                  when ? in ('failed', 'undelivered') then 'failed'
                  else status
                end
          where provider_message_id = ?`,
        [
          update.state,
          toMysqlDatetime(update.at),
          update.error ?? null,
          update.state,
          update.provider_message_id,
        ]
      );
      return found[0].revenue_event_id;
    },

    async listDueActions(nowIso: string, limit: number): Promise<DueAction[]> {
      const rows = await query<any>(
        `select ra.id, ad.revenue_event_id, ra.agent_decision_id, ra.channel,
                ra.attempt_number, ra.scheduled_for,
                re.amount_paise, re.currency, re.customer_contact
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
           join revenue_events re on re.id = ad.revenue_event_id
          where ra.scheduled_for is not null
            and ra.dispatched_at is null
            and ra.scheduled_for <= ?
          order by ra.scheduled_for asc
          limit ?`,
        [toMysqlDatetime(nowIso), limit]
      );
      return rows.map((r) => ({
        id: r.id,
        revenue_event_id: r.revenue_event_id,
        agent_decision_id: r.agent_decision_id,
        channel: r.channel,
        attempt_number: Number(r.attempt_number),
        scheduled_for: iso(r.scheduled_for),
        amount_paise: Number(r.amount_paise),
        currency: r.currency,
        customer_contact: r.customer_contact ?? null,
      }));
    },

    async claimDueAction(actionId: string, nowIso: string) {
      // `dispatched_at is null` in the WHERE clause is the lock. Two
      // overlapping cron ticks both see the row as due; exactly one update
      // matches, and the loser skips it rather than sending twice.
      const n = await affected(
        `update recovery_actions
            set dispatched_at = ?
          where id = ? and dispatched_at is null`,
        [toMysqlDatetime(nowIso), actionId]
      );
      return n > 0;
    },

    async completeDueAction(update: DispatchResult) {
      await exec(
        `update recovery_actions
            set status = ?,
                razorpay_payment_link_id =
                  coalesce(?, razorpay_payment_link_id),
                provider_message_id = coalesce(?, provider_message_id),
                delivery_state = coalesce(?, delivery_state),
                executed_at = ?
          where id = ?`,
        [
          update.status,
          update.razorpay_payment_link_id ?? null,
          update.provider_message_id ?? null,
          update.delivery_state ?? null,
          toMysqlDatetime(update.executed_at),
          update.action_id,
        ]
      );
    },

    async hitRateLimit(bucket: string, windowMs: number, nowIso: string) {
      /**
       * The increment is one statement and therefore atomic, which is the
       * property that matters — a per-process counter is per-lambda, and a
       * platform that spreads a burst across instances never lets any single
       * one reach its limit.
       *
       * The read back is a second statement, because MySQL has no RETURNING.
       * Both run on one pooled connection so they cannot be separated by a
       * pool handover, but another instance can still increment between them.
       * That can only make the count read HIGHER than this request's own,
       * never lower, so the limiter errs toward refusing early under
       * contention. For shedding load from a public endpoint that is the
       * direction to be wrong in.
       *
       * MySQL evaluates ON DUPLICATE KEY assignments left to right, so
       * `reset_at` still holds the old value when `count` is computed from
       * it, and again when its own expression reads it. The order of these
       * two lines is load-bearing.
       */
      const resetAt = new Date(new Date(nowIso).getTime() + windowMs).toISOString();
      const nowDt = toMysqlDatetime(nowIso);
      const resetDt = toMysqlDatetime(resetAt);

      const conn = await pool.getConnection();
      try {
        await conn.execute(
          `insert into rate_limit_windows (bucket, \`count\`, reset_at)
           values (?, 1, ?)
           on duplicate key update
             \`count\` = if(reset_at <= ?, 1, \`count\` + 1),
             reset_at = if(reset_at <= ?, ?, reset_at)`,
          [bucket, resetDt, nowDt, nowDt, resetDt]
        );
        const [rows] = await conn.query(
          "select `count`, reset_at from rate_limit_windows where bucket = ?",
          [bucket]
        );
        const row = (rows as any[])[0];
        return { count: Number(row.count), resetAt: iso(row.reset_at) };
      } finally {
        conn.release();
      }
    },

    async countLiveLinks() {
      // Simulated links are recorded with a `simulated_` id precisely so they
      // can be excluded here without a second column.
      const rows = await query<any>(
        `select count(*) as n from recovery_actions
          where razorpay_payment_link_id is not null
            and razorpay_payment_link_id not like 'simulated_%%'`
      );
      return Number(rows[0]?.n ?? rows[0]?.count ?? 0);
    },

    async getCustomerRetryHistory(customerId, limit) {
      const rows = await query<any>(
        `select ra.attempt_number, ra.channel, ra.status,
                coalesce(o.recovered, 0) as converted
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
           join revenue_events re on re.id = ad.revenue_event_id
           left join outcomes o on o.revenue_event_id = re.id
          where re.customer_id = ?
          order by ra.executed_at asc
          limit ?`,
        [customerId, limit]
      );
      return rows.map(
        (r): RetryAttempt => ({
          attempt_number: Number(r.attempt_number),
          channel: r.channel,
          status: r.status,
          converted: bool(r.converted),
        })
      );
    },

    // --- economics

    async countDecisionsByRootCause(rootCause) {
      const rows = await query<{ count: number }>(
        "select count(*) as count from agent_decisions where root_cause = ?",
        [rootCause]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async countRecoveredByRootCause(rootCause) {
      const rows = await query<{ count: number }>(
        `select count(*) as count
           from outcomes o
           join revenue_events re on re.id = o.revenue_event_id
          where re.root_cause = ? and o.recovered = 1`,
        [rootCause]
      );
      return Number(rows[0]?.count ?? 0);
    },

    // --- experiment

    async insertAssignment(row: AssignmentInsert) {
      const id = randomUUID();
      return insertOrDuplicate(
        `insert into experiment_assignments
           (id, revenue_event_id, arm, policy_version, recovery_probability, expected_value_paise)
         values (?,?,?,?,?,?)`,
        [
          id,
          row.revenue_event_id,
          row.arm,
          row.policy_version,
          row.recovery_probability,
          row.expected_value_paise,
        ],
        id
      );
    },

    // --- outcomes

    async findLatestFailedEventByOrderId(orderId) {
      const rows = await query<any>(
        `select id, received_at from revenue_events
          where razorpay_order_id = ? and event_type = 'payment.failed'
          order by received_at desc limit 1`,
        [orderId]
      );
      if (!rows[0]) return null;
      return { id: rows[0].id, received_at: iso(rows[0].received_at) };
    },

    async insertOutcome(row: OutcomeInsert) {
      const id = randomUUID();
      return insertOrDuplicate(
        `insert into outcomes
           (id, revenue_event_id, recovered, recovered_amount_paise, recovered_payment_id,
            attribution_window_minutes, resolved_at)
         values (?,?,?,?,?,?,?)`,
        [
          id,
          row.revenue_event_id,
          row.recovered ? 1 : 0,
          row.recovered_amount_paise,
          row.recovered_payment_id,
          row.attribution_window_minutes,
          toMysqlDatetime(row.resolved_at),
        ],
        id
      );
    },

    // --- dashboard reads

    async countEvents() {
      const rows = await query<any>("select count(*) as n from revenue_events");
      return Number(rows[0]?.n ?? 0);
    },

    async listEvents(limit?: number): Promise<RevenueEventRow[]> {
      // Most recent first only when bounded — an ORDER BY the unbounded
      // callers do not need is a sort of the whole table on every poll.
      const rows = await query<any>(
        `select id, customer_id, amount_paise, root_cause, razorpay_order_id,
                received_at, processed_at
           from revenue_events
          ${limit ? "order by received_at desc limit ?" : ""}`,
        limit ? [limit] : []
      );
      return rows.map((r) => ({
        id: r.id,
        customer_id: r.customer_id,
        amount_paise: Number(r.amount_paise),
        root_cause: r.root_cause,
        razorpay_order_id: r.razorpay_order_id ?? null,
        received_at: iso(r.received_at),
        processed_at: isoOrNull(r.processed_at),
      }));
    },

    async listOutcomes() {
      const rows = await query<any>(
        "select revenue_event_id, recovered, recovered_amount_paise, resolved_at from outcomes"
      );
      return rows.map((r) => ({
        revenue_event_id: r.revenue_event_id,
        recovered: bool(r.recovered),
        recovered_amount_paise:
          r.recovered_amount_paise === null ? null : Number(r.recovered_amount_paise),
        resolved_at: isoOrNull(r.resolved_at),
      }));
    },

    async listStoppingRules() {
      /**
       * Ordered oldest-first, because the callers treat the FIRST row for an
       * event as the one that stopped it — later rows are consequences, not
       * competing causes. Without an ORDER BY the database returns rows
       * plan-dependently, so an event with two stopping rules (which a
       * webhook retry produces routinely) would be attributed to whichever
       * row came back first. The money river's buckets and the replay
       * fidelity comparison both read this, so the same batch could report
       * different numbers on consecutive queries.
       */
      const rows = await query<any>(
        `select revenue_event_id,
                JSON_UNQUOTE(JSON_EXTRACT(detail, '$.reason')) as reason
           from audit_log where stage = 'stopping_rule_triggered'
          -- Ordered by time alone. An id tiebreak was here and was
          -- misleading: the ids are random UUIDs, so ordering by one is a
          -- coin flip dressed as determinism. Two stopping rules for the
          -- same event cannot share a timestamp in practice, since the
          -- pipeline writes them from sequential awaits, and pretending to
          -- break a tie that cannot happen only hides that.
          order by created_at asc`
      );
      return rows.map((r) => ({
        revenue_event_id: r.revenue_event_id,
        reason: r.reason ?? "unknown",
      }));
    },

    async listDecisionEventIds() {
      const rows = await query<{ revenue_event_id: string }>(
        "select revenue_event_id from agent_decisions"
      );
      return rows.map((r) => r.revenue_event_id);
    },

    async listAssignments() {
      const rows = await query<any>(
        "select revenue_event_id, arm, recovery_probability from experiment_assignments"
      );
      return rows.map((r) => ({
        revenue_event_id: r.revenue_event_id,
        arm: r.arm,
        // Numeric columns come back as strings on both drivers often enough
        // that coercing here is cheaper than debugging a silent NaN later.
        recovery_probability:
          r.recovery_probability === null || r.recovery_probability === undefined
            ? null
            : Number(r.recovery_probability),
      }));
    },

    async listRecentAudit(limit, stages): Promise<AuditRow[]> {
      // See the Postgres implementation: filtering after the fact lets a
      // batch's outcome rows crowd the reasoning out of the feed.
      const rows = stages?.length
        ? await query<any>(
            `select id, revenue_event_id, stage, detail, created_at
               from audit_log where stage in (${stages.map(() => "?").join(",")})
              order by created_at desc limit ?`,
            [...stages, limit]
          )
        : await query<any>(
            `select id, revenue_event_id, stage, detail, created_at
               from audit_log order by created_at desc limit ?`,
            [limit]
          );
      return rows.map((r) => ({
        id: r.id,
        revenue_event_id: r.revenue_event_id,
        stage: r.stage,
        // mysql2 parses JSON columns already; a string means it didn't.
        detail: typeof r.detail === "string" ? JSON.parse(r.detail) : (r.detail ?? {}),
        created_at: iso(r.created_at),
      }));
    },

    async listEventsByIds(ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(",");
      const rows = await query<any>(
        `select id, amount_paise, root_cause, customer_id
           from revenue_events where id in (${placeholders})`,
        ids
      );
      return rows.map((r) => ({
        id: r.id,
        amount_paise: Number(r.amount_paise),
        root_cause: r.root_cause,
        customer_id: r.customer_id,
      }));
    },

    // --- conformance

    async listAuditForEvent(revenueEventId: string): Promise<AuditRow[]> {
      // Ascending and unbounded — see the Postgres implementation for why a
      // trace must not be truncated.
      const rows = await query<any>(
        `select id, revenue_event_id, stage, detail, created_at
           from audit_log where revenue_event_id = ? order by created_at asc`,
        [revenueEventId]
      );
      return rows.map((r) => ({
        id: r.id,
        revenue_event_id: r.revenue_event_id,
        stage: r.stage,
        detail: typeof r.detail === "string" ? JSON.parse(r.detail) : (r.detail ?? {}),
        created_at: iso(r.created_at),
      }));
    },

    async findDecisionForEvent(revenueEventId: string): Promise<DecisionRow | null> {
      const rows = await query<any>(
        `select id, revenue_event_id, chosen_action, rationale, from_cache, cache_key
           from agent_decisions where revenue_event_id = ?
          order by decided_at asc limit 1`,
        [revenueEventId]
      );
      if (rows.length === 0) return null;
      return { ...rows[0], from_cache: bool(rows[0].from_cache) };
    },

    async findOutcomeForEvent(revenueEventId: string) {
      const rows = await query<any>(
        `select revenue_event_id, recovered, recovered_amount_paise, resolved_at
           from outcomes where revenue_event_id = ? limit 1`,
        [revenueEventId]
      );
      if (rows.length === 0) return null;
      return {
        revenue_event_id: rows[0].revenue_event_id,
        recovered: bool(rows[0].recovered),
        recovered_amount_paise:
          rows[0].recovered_amount_paise === null ? null : Number(rows[0].recovered_amount_paise),
        resolved_at: rows[0].resolved_at ? iso(rows[0].resolved_at) : null,
      };
    },

    async listDecisions(): Promise<DecisionRow[]> {
      const rows = await query<any>(
        "select id, revenue_event_id, chosen_action, rationale, from_cache, cache_key from agent_decisions"
      );
      return rows.map((r) => ({ ...r, from_cache: bool(r.from_cache) }));
    },

    async listRecoveryActions(): Promise<RecoveryActionRow[]> {
      const rows = await query<any>(
        `select agent_decision_id, channel, status, attempt_number, executed_at
           from recovery_actions`
      );
      return rows.map((r) => ({
        agent_decision_id: r.agent_decision_id,
        channel: r.channel,
        status: r.status,
        attempt_number: Number(r.attempt_number),
        executed_at: iso(r.executed_at),
      }));
    },

    async listConsent() {
      const rows = await query<any>("select customer_id, dnd from customer_consent");
      return rows.map((r) => ({ customer_id: r.customer_id, dnd: bool(r.dnd) }));
    },

    // --- seeding

    async upsertConsent(rows) {
      if (rows.length === 0) return;
      // customer_id is the primary key here — there is no separate id column.
      const values: any[] = [];
      const tuples = rows.map((r) => {
        values.push(r.customer_id, r.dnd ? 1 : 0, r.whatsapp_opt_in ? 1 : 0, r.email_opt_in ? 1 : 0);
        return "(?,?,?,?)";
      });

      await query(
        `insert into customer_consent (customer_id, dnd, whatsapp_opt_in, email_opt_in)
         values ${tuples.join(",")}
         on duplicate key update
           dnd = values(dnd),
           whatsapp_opt_in = values(whatsapp_opt_in),
           email_opt_in = values(email_opt_in)`,
        values
      );
    },
  };
}
