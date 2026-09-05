/**
 * The pipeline's data contract.
 *
 * Expressed as domain operations ("has this customer been contacted
 * recently?") rather than queries, so the same pipeline runs unchanged on
 * PostgreSQL and MySQL. Razorpay's published stack uses MySQL historically
 * and PostgreSQL / Aurora PostgreSQL for newer transactional systems, so
 * this project runs on either rather than picking a side.
 *
 * Two rules the implementations must both honour:
 *
 * 1. **Infrastructure failures throw.** They never return null, an empty
 *    array, or zero. Every guardrail in this system is fail-closed, and that
 *    only works if "the query failed" is distinguishable from "there is no
 *    such row". Returning a falsy value on error is exactly how a database
 *    blip silently disables a safety rule.
 *
 * 2. **Duplicate inserts are reported, not thrown.** Webhook retries are
 *    normal traffic, and the two engines signal a unique violation
 *    differently (Postgres `23505`, MySQL `ER_DUP_ENTRY`/1062). Each
 *    implementation normalises that to `{ duplicate: true }` so the pipeline
 *    never has to know which database it is talking to.
 */

export interface RevenueEventInsert {
  razorpay_event_id: string;
  event_type: string;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
  amount_paise: number;
  currency: string;
  error_code: string | null;
  error_description: string | null;
  payment_method: string | null;
  customer_id: string | null;
  customer_contact: string | null;
  raw_payload: unknown;
  /**
   * When the payment actually failed, from the Razorpay entity's own
   * `created_at`. Omitted when the payload does not carry one, in which case
   * the column defaults to now().
   */
  received_at?: string;
}

export interface RevenueEventRow {
  id: string;
  customer_id: string | null;
  amount_paise: number;
  root_cause: string | null;
  /** Needed to attribute a recovery back to the failure it belongs to. */
  razorpay_order_id: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface DecisionInsert {
  revenue_event_id: string;
  root_cause: string;
  chosen_action: string;
  rationale: string;
  bounded_by: string[];
  /** True when reused from decision_cache rather than reasoned fresh. */
  from_cache?: boolean;
  cache_key?: string | null;
}

export interface CachedDecision {
  chosen_action: string;
  rationale: string;
  model: string;
}

export interface DecisionRow {
  id: string;
  revenue_event_id: string;
  chosen_action: string;
  rationale: string | null;
  from_cache?: boolean;
  /** Which situation this decision answered — see lib/decision-cache.ts. */
  cache_key?: string | null;
}

export interface RecoveryActionInsert {
  agent_decision_id: string;
  /**
   * When the send happened, on the event's timeline rather than the server's.
   *
   * In production these coincide and this is a no-op. In a backfilled batch
   * they do not: events carry historical timestamps while the sends run now,
   * which puts every action *after* every event and makes the cooldown
   * unanswerable — a guardrail asking about a customer's past finds only
   * contact from its future. Stamping the action with the event's time keeps
   * the timeline internally consistent.
   */
  executed_at?: string;
  channel: string;
  action_type: string;
  status: string;
  attempt_number: number;
  razorpay_payment_link_id?: string | null;
  /**
   * Meta's id for the message, stored because it is the only handle that
   * connects this row to Meta's own record of it. Without it a later delivery
   * callback has nothing to join on, and a claim in the audit trail cannot be
   * traced back to the message it describes.
   */
  provider_message_id?: string | null;
  /** Meta's own word for it. `accepted` is weaker than delivered. */
  delivery_state?: string | null;
  /**
   * When this send should happen, if not now. Null means immediately, which
   * is what every action written before this column existed meant.
   */
  scheduled_for?: string | null;
}

/**
 * A send that was decided but deliberately deferred, loaded with everything
 * the dispatcher needs to execute it without re-deriving the decision.
 *
 * The decision is not revisited at dispatch time. It was made under the
 * guardrails, recorded, and audited; re-running the gates hours later against
 * a changed world would mean the trail describes a decision the system did
 * not act on.
 */
export interface DueAction {
  id: string;
  revenue_event_id: string;
  agent_decision_id: string;
  channel: string;
  attempt_number: number;
  scheduled_for: string;
  amount_paise: number;
  currency: string;
  customer_contact: string | null;
}

export interface RecoveryActionRow {
  agent_decision_id: string;
  channel: string;
  status: string;
  attempt_number: number;
  executed_at: string;
}

export interface AssignmentInsert {
  revenue_event_id: string;
  arm: string;
  policy_version: string;
  recovery_probability: number;
  expected_value_paise: number;
}

export interface OutcomeInsert {
  revenue_event_id: string;
  recovered: boolean;
  recovered_amount_paise: number;
  recovered_payment_id: string;
  attribution_window_minutes: number;
  resolved_at: string;
}

export interface AuditRow {
  id: string;
  revenue_event_id: string;
  stage: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface RetryAttempt {
  attempt_number: number;
  channel: string;
  /** DELIVERY status — sent, failed, simulated. Not whether it worked. */
  status: string;
  /**
   * Whether the payment this attempt chased was ultimately recovered.
   *
   * The agent is supposed to reason "WhatsApp twice already, no conversion,
   * escalate" — and it could not, because everything it was told was about
   * whether the MESSAGE went out, never whether the customer paid. A nudge
   * that was delivered perfectly and ignored, and one that was delivered and
   * worked, arrived at the model as the same string. The single most
   * decision-relevant fact about a prior attempt was the one fact missing.
   */
  converted: boolean;
}

export interface DeliveryStatusUpdate {
  provider_message_id: string;
  /** The provider's own vocabulary, not ours — `sent`, `delivered`, `read`, `failed`. */
  state: string;
  at: string;
  error?: string | null;
}

export interface DispatchResult {
  action_id: string;
  status: string;
  razorpay_payment_link_id?: string | null;
  provider_message_id?: string | null;
  delivery_state?: string | null;
  executed_at: string;
}

/** Signals a unique-constraint hit without leaking the engine's error code. */
export type InsertResult = { id: string } | { duplicate: true };

export interface RecoveryDb {
  /** Which engine is backing this instance — surfaced by preflight. */
  readonly driver: "postgres" | "mysql";

  /** Cheap round trip proving the connection and credentials work. */
  ping(): Promise<void>;
  /** Confirms every table the pipeline writes to exists. */
  missingTables(): Promise<string[]>;
  close(): Promise<void>;

  // --- ingestion
  findEventIdByRazorpayEventId(razorpayEventId: string): Promise<string | null>;
  /** Maps a refund/dispute webhook back to the failure it relates to. */
  findEventIdByPaymentId(razorpayPaymentId: string): Promise<string | null>;
  /**
   * The payload this event was created from. A resumed delivery must be
   * processed against the payload that produced the row, not whatever arrives
   * with the retry — see the resume path in the webhook.
   */
  getStoredPayload(revenueEventId: string): Promise<any | null>;
  insertRevenueEvent(row: RevenueEventInsert): Promise<InsertResult>;
  setClassification(eventId: string, rootCause: string, processedAt: string): Promise<void>;

  // --- audit trail
  insertAudit(
    revenueEventId: string,
    stage: string,
    detail: Record<string, unknown>
  ): Promise<void>;

  // --- guardrails
  getConsent(customerId: string): Promise<{ dnd: boolean } | null>;
  countActionsForEvent(revenueEventId: string): Promise<number>;
  /**
   * Was this customer contacted inside the window [sinceIso, untilIso]?
   *
   * The upper bound is not optional decoration. A backdated or
   * delayed-delivery event is processed after sends that happened later than
   * the event itself, and an open-ended "since" would count those as prior
   * contact — blocking an event on a message that had not been sent when it
   * arrived. The cooldown is a question about the customer's past, so the
   * query has to be bounded at both ends.
   */
  hasActionForCustomerSince(
    customerId: string,
    sinceIso: string,
    untilIso: string
  ): Promise<boolean>;
  getEventPaymentId(revenueEventId: string): Promise<string | null>;
  /** True when a refund/dispute stopping rule was already recorded. */
  hasDisputeFlag(revenueEventId: string): Promise<boolean>;

  // --- agent + execution
  countDecisionsForEvent(revenueEventId: string): Promise<number>;
  /**
   * Records the agent's decision, at most once per event.
   *
   * `duplicate: true` means another delivery of the same event already
   * decided it, and the id returned is that decision's. The webhook's
   * "have we decided yet?" check is a read followed by a write, and two
   * concurrent redeliveries interleaved between the two — both saw no
   * decision, both proceeded, and one customer got two payment links four
   * seconds apart. A unique constraint is the only thing that makes the
   * check atomic; the application cannot do it by remembering harder.
   */
  insertDecision(row: DecisionInsert): Promise<{ id: string; duplicate?: boolean }>;
  insertRecoveryAction(row: RecoveryActionInsert): Promise<void>;
  /**
   * How many REAL Razorpay payment links this deployment has created.
   *
   * Test mode allows thirty in total, and the guard that rations them cannot
   * live in module state — a dev server reload resets it, and the budget
   * silently stops guarding. The database is the only counter that survives.
   */
  countLiveLinks(): Promise<number>;
  getCustomerRetryHistory(customerId: string, limit: number): Promise<RetryAttempt[]>;

  // --- economics
  countDecisionsByRootCause(rootCause: string): Promise<number>;
  countRecoveredByRootCause(rootCause: string): Promise<number>;

  // --- decision memoisation
  getCachedDecision(cacheKey: string): Promise<CachedDecision | null>;
  putCachedDecision(row: CachedDecision & { cache_key: string }): Promise<void>;
  countCachedDecisions(): Promise<number>;

  // --- experiment
  insertAssignment(row: AssignmentInsert): Promise<InsertResult>;

  // --- outcomes
  findLatestFailedEventByOrderId(
    orderId: string
  ): Promise<{ id: string; received_at: string } | null>;
  insertOutcome(row: OutcomeInsert): Promise<InsertResult>;

  // --- dashboard reads
  /**
   * Every event, or the most recent `limit` of them.
   *
   * Unbounded by default because the conformance verifier must never check a
   * slice and report a clean pass — see `countEvents`. The bounded form is
   * for callers that are producing an estimate rather than an attestation.
   */
  listEvents(limit?: number): Promise<RevenueEventRow[]>;
  /**
   * How many events exist, without loading any of them.
   *
   * The verifier and the replay engine both read whole tables into memory.
   * That is correct at this project's volume and wrong at six figures, and
   * the difference has to be visible to the caller rather than discovered as
   * an out-of-memory kill. Counting first lets each of them choose: the
   * verifier refuses, the replay engine truncates and says so.
   */
  countEvents(): Promise<number>;
  listOutcomes(): Promise<
    {
      revenue_event_id: string;
      recovered: boolean;
      recovered_amount_paise: number | null;
      resolved_at: string | null;
    }[]
  >;
  listStoppingRules(): Promise<{ revenue_event_id: string; reason: string }[]>;
  listDecisionEventIds(): Promise<string[]>;
  /**
   * Includes the probability estimated at assignment time. The replay engine
   * needs the number the pipeline actually used, not one recomputed today
   * against different observed stats — a counterfactual that silently swaps
   * its own inputs is comparing two things at once.
   */
  listAssignments(): Promise<
    { revenue_event_id: string; arm: string; recovery_probability: number | null }[]
  >;
  listRecentAudit(limit: number, stages?: string[]): Promise<AuditRow[]>;
  /**
   * Every audit row for one event, oldest first — the trace view reads the
   * pipeline forwards, unlike the feed, which reads it backwards.
   */
  listAuditForEvent(revenueEventId: string): Promise<AuditRow[]>;
  listEventsByIds(ids: string[]): Promise<
    { id: string; amount_paise: number; root_cause: string | null; customer_id: string | null }[]
  >;

  /**
   * The decision and outcome for ONE event.
   *
   * The trace view previously found these by loading every decision and every
   * outcome in the batch and filtering in memory — nine hundred rows fetched
   * to use one. Free against a local database and roughly a megabyte per page
   * view once the database is a network hop away.
   */
  findDecisionForEvent(revenueEventId: string): Promise<DecisionRow | null>;
  findOutcomeForEvent(revenueEventId: string): Promise<{
    revenue_event_id: string;
    recovered: boolean;
    recovered_amount_paise: number | null;
    resolved_at: string | null;
  } | null>;

  // --- conformance verifier
  listDecisions(): Promise<DecisionRow[]>;
  listRecoveryActions(): Promise<RecoveryActionRow[]>;
  listConsent(): Promise<{ customer_id: string; dnd: boolean }[]>;

  // --- delivery callbacks
  /**
   * Records what the provider later said about a message.
   *
   * Returns the revenue event the message belonged to, or null when no action
   * carries that id.
   *
   * An unmatched callback is normal traffic — Meta re-sends statuses, and a
   * status can arrive for a message this deployment did not send — so it must
   * not be treated as an error. The event id is returned rather than a
   * boolean because the audit trail is keyed on events: a delivery status
   * that cannot be filed against the payment it chased is a fact with nowhere
   * to live.
   */
  recordDeliveryStatus(update: DeliveryStatusUpdate): Promise<string | null>;

  // --- scheduled sends
  /** Sends whose time has come and which have not yet been dispatched. */
  listDueActions(nowIso: string, limit: number): Promise<DueAction[]>;
  /**
   * Claims one due send, atomically.
   *
   * Two cron invocations can overlap — a slow dispatch and the next tick —
   * and both would otherwise read the same due row and send twice. The claim
   * is a conditional update that only one of them can win: `dispatched_at is
   * null` in the WHERE clause is the lock. Returns false for the loser, which
   * then skips the row rather than racing it.
   */
  claimDueAction(actionId: string, nowIso: string): Promise<boolean>;
  /** Records how a dispatched send actually went. */
  completeDueAction(update: DispatchResult): Promise<void>;

  // --- rate limiting
  /**
   * Increments the shared counter for `bucket` and returns its new value.
   *
   * One statement, so the increment is atomic across every instance sharing
   * this database — which is the entire point, since an in-memory counter is
   * per-lambda and a platform that spreads a burst across instances never
   * lets any single one reach its limit.
   */
  hitRateLimit(
    bucket: string,
    windowMs: number,
    nowIso: string
  ): Promise<{ count: number; resetAt: string }>;

  // --- seeding
  upsertConsent(
    rows: { customer_id: string; dnd: boolean; whatsapp_opt_in: boolean; email_opt_in: boolean }[]
  ): Promise<void>;
}
