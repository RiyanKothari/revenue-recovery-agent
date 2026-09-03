import { Pool } from "pg";
import type {
  AssignmentInsert,
  AuditRow,
  DecisionInsert,
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
 * PostgreSQL implementation, over `pg` rather than a hosted SDK so it runs
 * against any Postgres — Supabase, RDS, or the Aurora PostgreSQL that
 * Razorpay's published stack uses for newer transactional systems.
 *
 * Errors are allowed to propagate on purpose. Every guardrail above this
 * layer is fail-closed, and that depends on being able to tell "the query
 * failed" from "no such row" — swallowing an error into a null return is
 * precisely how a database blip silently disables a safety rule.
 */

const UNIQUE_VIOLATION = "23505";

const TABLES = [
  "revenue_events",
  "agent_decisions",
  "recovery_actions",
  "outcomes",
  "customer_consent",
  "audit_log",
  "experiment_assignments",
  "decision_cache",
];

/** Postgres returns timestamptz as a Date; the pipeline speaks ISO strings. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

export function createPostgresDb(connectionString: string): RecoveryDb {
  const pool = new Pool({
    connectionString,
    // Managed Postgres (Supabase, RDS) terminates TLS with certificates that
    // aren't in Node's default trust store. The connection is still
    // encrypted; only the certificate chain check is relaxed.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
    max: 5,
  });

  const query = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => {
    const result = await pool.query(text, params as any[]);
    return result.rows as T[];
  };

  const insertOrDuplicate = async (
    text: string,
    params: unknown[]
  ): Promise<InsertResult> => {
    try {
      const rows = await query<{ id: string }>(text, params);
      return { id: rows[0].id };
    } catch (err: any) {
      if (err?.code === UNIQUE_VIOLATION) return { duplicate: true };
      throw err;
    }
  };

  return {
    driver: "postgres",

    async ping() {
      await query("select 1");
    },

    async missingTables() {
      const rows = await query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name = any($1)`,
        [TABLES]
      );
      const present = new Set(rows.map((r) => r.table_name));
      return TABLES.filter((t) => !present.has(t));
    },

    async close() {
      await pool.end();
    },

    // --- ingestion

    async findEventIdByRazorpayEventId(razorpayEventId) {
      const rows = await query<{ id: string }>(
        "select id from revenue_events where razorpay_event_id = $1 limit 1",
        [razorpayEventId]
      );
      return rows[0]?.id ?? null;
    },

    async findEventIdByPaymentId(razorpayPaymentId) {
      const rows = await query<{ id: string }>(
        `select id from revenue_events
          where razorpay_payment_id = $1
          order by received_at desc limit 1`,
        [razorpayPaymentId]
      );
      return rows[0]?.id ?? null;
    },

    async getStoredPayload(revenueEventId) {
      const rows = await query<{ raw_payload: any }>(
        "select raw_payload from revenue_events where id = $1 limit 1",
        [revenueEventId]
      );
      return rows[0]?.raw_payload ?? null;
    },

    async insertRevenueEvent(row: RevenueEventInsert) {
      return insertOrDuplicate(
        `insert into revenue_events
           (razorpay_event_id, event_type, razorpay_payment_id, razorpay_order_id,
            amount_paise, currency, error_code, error_description, payment_method,
            customer_id, customer_contact, raw_payload, received_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, coalesce($13::timestamptz, now()))
         returning id`,
        [
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
          row.received_at ?? null,
        ]
      );
    },

    async setClassification(eventId, rootCause, processedAt) {
      await query(
        "update revenue_events set root_cause = $1, processed_at = $2 where id = $3",
        [rootCause, processedAt, eventId]
      );
    },

    // --- audit

    async insertAudit(revenueEventId, stage, detail) {
      await query(
        "insert into audit_log (revenue_event_id, stage, detail) values ($1,$2,$3)",
        [revenueEventId, stage, JSON.stringify(detail)]
      );
    },

    // --- guardrails

    async getConsent(customerId) {
      const rows = await query<{ dnd: boolean }>(
        "select dnd from customer_consent where customer_id = $1 limit 1",
        [customerId]
      );
      return rows[0] ? { dnd: Boolean(rows[0].dnd) } : null;
    },

    async countActionsForEvent(revenueEventId) {
      const rows = await query<{ count: string }>(
        `select count(*)::text as count
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
          where ad.revenue_event_id = $1`,
        [revenueEventId]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async hasActionForCustomerSince(customerId, sinceIso, untilIso) {
      const rows = await query(
        `select 1
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
           join revenue_events re on re.id = ad.revenue_event_id
          where re.customer_id = $1
            and ra.executed_at >= $2
            and ra.executed_at <= $3
          limit 1`,
        [customerId, sinceIso, untilIso]
      );
      return rows.length > 0;
    },

    async getEventPaymentId(revenueEventId) {
      const rows = await query<{ razorpay_payment_id: string | null }>(
        "select razorpay_payment_id from revenue_events where id = $1 limit 1",
        [revenueEventId]
      );
      if (rows.length === 0) throw new Error(`No revenue_event ${revenueEventId}`);
      return rows[0].razorpay_payment_id;
    },

    async hasDisputeFlag(revenueEventId) {
      const rows = await query(
        `select 1 from audit_log
          where revenue_event_id = $1
            and stage = 'stopping_rule_triggered'
            and detail @> '{"reason":"refund_or_dispute"}'::jsonb
          limit 1`,
        [revenueEventId]
      );
      return rows.length > 0;
    },

    // --- agent + execution

    async countDecisionsForEvent(revenueEventId) {
      const rows = await query<{ count: string }>(
        "select count(*)::text as count from agent_decisions where revenue_event_id = $1",
        [revenueEventId]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async insertDecision(row: DecisionInsert) {
      const rows = await query<{ id: string }>(
        `insert into agent_decisions
           (revenue_event_id, root_cause, chosen_action, rationale, bounded_by, from_cache, cache_key)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [
          row.revenue_event_id,
          row.root_cause,
          row.chosen_action,
          row.rationale,
          row.bounded_by,
          row.from_cache ?? false,
          row.cache_key ?? null,
        ]
      );
      return { id: rows[0].id };
    },

    // --- decision memoisation

    async getCachedDecision(cacheKey) {
      const rows = await query<any>(
        "select chosen_action, rationale, model from decision_cache where cache_key = $1",
        [cacheKey]
      );
      return rows[0] ?? null;
    },

    async putCachedDecision(row) {
      // Two events with the same situation can race; whichever lands first
      // wins and the other reuses it. Identical inputs, identical answer.
      await query(
        `insert into decision_cache (cache_key, chosen_action, rationale, model)
         values ($1,$2,$3,$4)
         on conflict (cache_key) do nothing`,
        [row.cache_key, row.chosen_action, row.rationale, row.model]
      );
    },

    async countCachedDecisions() {
      const rows = await query<{ count: string }>(
        "select count(*)::text as count from decision_cache"
      );
      return Number(rows[0]?.count ?? 0);
    },

    async insertRecoveryAction(row: RecoveryActionInsert) {
      await query(
        `insert into recovery_actions
           (agent_decision_id, channel, action_type, status, attempt_number,
            razorpay_payment_link_id, executed_at)
         values ($1,$2,$3,$4,$5,$6, coalesce($7::timestamptz, now()))`,
        [
          row.agent_decision_id,
          row.channel,
          row.action_type,
          row.status,
          row.attempt_number,
          row.razorpay_payment_link_id ?? null,
          row.executed_at ?? null,
        ]
      );
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
      const rows = await query<RetryAttempt>(
        `select ra.attempt_number, ra.channel, ra.status
           from recovery_actions ra
           join agent_decisions ad on ad.id = ra.agent_decision_id
           join revenue_events re on re.id = ad.revenue_event_id
          where re.customer_id = $1
          order by ra.executed_at asc
          limit $2`,
        [customerId, limit]
      );
      return rows;
    },

    // --- economics

    async countDecisionsByRootCause(rootCause) {
      const rows = await query<{ count: string }>(
        "select count(*)::text as count from agent_decisions where root_cause = $1",
        [rootCause]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async countRecoveredByRootCause(rootCause) {
      const rows = await query<{ count: string }>(
        `select count(*)::text as count
           from outcomes o
           join revenue_events re on re.id = o.revenue_event_id
          where re.root_cause = $1 and o.recovered = true`,
        [rootCause]
      );
      return Number(rows[0]?.count ?? 0);
    },

    // --- experiment

    async insertAssignment(row: AssignmentInsert) {
      return insertOrDuplicate(
        `insert into experiment_assignments
           (revenue_event_id, arm, policy_version, recovery_probability, expected_value_paise)
         values ($1,$2,$3,$4,$5) returning id`,
        [
          row.revenue_event_id,
          row.arm,
          row.policy_version,
          row.recovery_probability,
          row.expected_value_paise,
        ]
      );
    },

    // --- outcomes

    async findLatestFailedEventByOrderId(orderId) {
      const rows = await query<{ id: string; received_at: unknown }>(
        `select id, received_at from revenue_events
          where razorpay_order_id = $1 and event_type = 'payment.failed'
          order by received_at desc limit 1`,
        [orderId]
      );
      if (!rows[0]) return null;
      return { id: rows[0].id, received_at: iso(rows[0].received_at) };
    },

    async insertOutcome(row: OutcomeInsert) {
      return insertOrDuplicate(
        `insert into outcomes
           (revenue_event_id, recovered, recovered_amount_paise, recovered_payment_id,
            attribution_window_minutes, resolved_at)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [
          row.revenue_event_id,
          row.recovered,
          row.recovered_amount_paise,
          row.recovered_payment_id,
          row.attribution_window_minutes,
          row.resolved_at,
        ]
      );
    },

    // --- dashboard reads

    async listEvents(): Promise<RevenueEventRow[]> {
      const rows = await query<any>(
        `select id, customer_id, amount_paise, root_cause, razorpay_order_id,
                received_at, processed_at
           from revenue_events`
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
        `select revenue_event_id, recovered, recovered_amount_paise, resolved_at from outcomes`
      );
      return rows.map((r) => ({
        revenue_event_id: r.revenue_event_id,
        recovered: Boolean(r.recovered),
        recovered_amount_paise:
          r.recovered_amount_paise === null ? null : Number(r.recovered_amount_paise),
        resolved_at: isoOrNull(r.resolved_at),
      }));
    },

    async listStoppingRules() {
      const rows = await query<any>(
        `select revenue_event_id, detail->>'reason' as reason
           from audit_log where stage = 'stopping_rule_triggered'`
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
      // Filtering in SQL, not after. The feed shows reasoning, and a batch
      // writes far more outcome and classification rows than decisions — a
      // plain "last 100 of everything" window fills with them and the
      // reasoning panel renders empty while the pipeline is working fine.
      const rows = stages?.length
        ? await query<any>(
            `select id, revenue_event_id, stage, detail, created_at
               from audit_log where stage = any($1)
              order by created_at desc limit $2`,
            [stages, limit]
          )
        : await query<any>(
            `select id, revenue_event_id, stage, detail, created_at
               from audit_log order by created_at desc limit $1`,
            [limit]
          );
      return rows.map((r) => ({
        id: r.id,
        revenue_event_id: r.revenue_event_id,
        stage: r.stage,
        detail: r.detail ?? {},
        created_at: iso(r.created_at),
      }));
    },

    async listEventsByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await query<any>(
        `select id, amount_paise, root_cause, customer_id
           from revenue_events where id = any($1)`,
        [ids]
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
      // Ascending: a trace is read in the order the pipeline ran, and no
      // limit, because a truncated trace would silently drop the stage that
      // explains the outcome.
      const rows = await query<any>(
        `select id, revenue_event_id, stage, detail, created_at
           from audit_log where revenue_event_id = $1 order by created_at asc`,
        [revenueEventId]
      );
      return rows.map((r) => ({
        id: r.id,
        revenue_event_id: r.revenue_event_id,
        stage: r.stage,
        detail: r.detail ?? {},
        created_at: iso(r.created_at),
      }));
    },

    async listDecisions(): Promise<DecisionRow[]> {
      const rows = await query<any>(
        "select id, revenue_event_id, chosen_action, rationale, from_cache, cache_key from agent_decisions"
      );
      return rows.map((r) => ({ ...r, from_cache: Boolean(r.from_cache) }));
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
      return rows.map((r) => ({ customer_id: r.customer_id, dnd: Boolean(r.dnd) }));
    },

    // --- seeding

    async upsertConsent(rows) {
      if (rows.length === 0) return;
      // One statement rather than a loop: 600 round trips would dominate the
      // seed script's runtime.
      const values: unknown[] = [];
      const tuples = rows.map((r, i) => {
        const base = i * 4;
        values.push(r.customer_id, r.dnd, r.whatsapp_opt_in, r.email_opt_in);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4})`;
      });

      await query(
        `insert into customer_consent (customer_id, dnd, whatsapp_opt_in, email_opt_in)
         values ${tuples.join(",")}
         on conflict (customer_id) do update set
           dnd = excluded.dnd,
           whatsapp_opt_in = excluded.whatsapp_opt_in,
           email_opt_in = excluded.email_opt_in`,
        values
      );
    },
  };
}
