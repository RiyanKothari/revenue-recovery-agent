-- MySQL / TiDB schema. The Postgres reference lives in schema.postgres.sql;
-- this is the same model expressed in MySQL's type system.
--
-- Razorpay's published stack runs MySQL historically and PostgreSQL / Aurora
-- PostgreSQL for newer transactional systems, so the pipeline supports both.
-- Every difference below is forced by the engine, not a design change:
--
--   uuid            -> CHAR(36)      MySQL has no uuid type. Ids are generated
--                                    in the application (see lib/db/mysql.ts),
--                                    because MySQL has neither
--                                    gen_random_uuid() defaults nor RETURNING.
--   jsonb           -> JSON          Queried with JSON_EXTRACT rather than @>.
--   timestamptz     -> DATETIME(3)   MySQL DATETIME carries no zone, so the
--                                    application writes UTC and the pool is
--                                    pinned to UTC (timezone: "Z").
--   boolean         -> TINYINT(1)    Reads back as 0/1.
--   text[]          -> JSON          MySQL has no array type.
--
-- Tables are InnoDB for foreign keys and transactional integrity, which the
-- audit trail depends on.

create table if not exists revenue_events (
  id char(36) primary key,
  razorpay_event_id varchar(191) not null unique,   -- the real idempotency enforcement
  event_type varchar(64) not null,
  razorpay_payment_id varchar(191),
  razorpay_order_id varchar(191),
  amount_paise bigint not null,
  currency varchar(8) not null default 'INR',
  error_code varchar(191),
  error_description text,
  payment_method varchar(64),
  root_cause varchar(64),
  customer_id varchar(191),
  customer_contact varchar(191),
  raw_payload json not null,
  received_at datetime(3) not null default current_timestamp(3),
  processed_at datetime(3)
) engine=InnoDB;

create table if not exists agent_decisions (
  id char(36) primary key,
  revenue_event_id char(36) not null,
  root_cause varchar(64) not null,
  chosen_action varchar(64) not null,
  rationale text not null,                          -- the explainability artifact
  bounded_by json not null,
  from_cache tinyint(1) not null default 0,
  cache_key varchar(191),
  model varchar(64) not null default 'claude',
  decided_at datetime(3) not null default current_timestamp(3),
  constraint fk_decision_event foreign key (revenue_event_id) references revenue_events(id)
) engine=InnoDB;

create table if not exists recovery_actions (
  id char(36) primary key,
  agent_decision_id char(36) not null,
  channel varchar(32) not null,
  action_type varchar(32) not null,
  razorpay_payment_link_id varchar(191),
  status varchar(32) not null default 'sent',
  attempt_number int not null default 1,
  executed_at datetime(3) not null default current_timestamp(3),
  constraint fk_action_decision foreign key (agent_decision_id) references agent_decisions(id)
) engine=InnoDB;

create table if not exists outcomes (
  id char(36) primary key,
  -- unique: order.paid can be delivered more than once, and double-counting
  -- here would inflate the headline "amount recovered" number
  revenue_event_id char(36) not null unique,
  recovered tinyint(1) not null default 0,
  recovered_amount_paise bigint,
  recovered_payment_id varchar(191),
  attribution_window_minutes int not null default 60,
  resolved_at datetime(3),
  constraint fk_outcome_event foreign key (revenue_event_id) references revenue_events(id)
) engine=InnoDB;

create table if not exists customer_consent (
  customer_id varchar(191) primary key,
  whatsapp_opt_in tinyint(1) not null default 1,
  email_opt_in tinyint(1) not null default 1,
  dnd tinyint(1) not null default 0,
  updated_at datetime(3) not null default current_timestamp(3) on update current_timestamp(3)
) engine=InnoDB;

-- Append-only audit trail. This is what the dashboard's "live feed" reads.
--
-- Append-only is a hard constraint, not a convention: nothing in the codebase
-- updates or deletes from this table, so the record of what the agent did
-- cannot be rewritten after the fact. It is also event-shaped — one immutable
-- row per pipeline stage, with a `stage` discriminator and a JSON payload —
-- which is exactly what a CDC topic wants. At production volume the dashboard
-- would read this off a stream (Maxwell on MySQL binlogs, per Razorpay's own
-- stack) rather than polling.
create table if not exists audit_log (
  id char(36) primary key,
  revenue_event_id char(36) not null,
  stage varchar(64) not null,
  detail json not null,
  created_at datetime(3) not null default current_timestamp(3),
  constraint fk_audit_event foreign key (revenue_event_id) references revenue_events(id)
) engine=InnoDB;

-- Memoised agent decisions, keyed on the situation rather than the event.
-- See db/schema.postgres.sql for the full rationale; every reuse is recorded
-- on agent_decisions.from_cache so the audit trail stays honest.
create table if not exists decision_cache (
  cache_key varchar(191) primary key,
  chosen_action varchar(64) not null,
  rationale text not null,
  model varchar(128) not null,
  created_at datetime(3) not null default current_timestamp(3)
) engine=InnoDB;

-- A slice of otherwise-eligible events is deliberately left untreated so
-- recovery can be MEASURED against a do-nothing baseline rather than merely
-- attributed. Assignment is a pure function of revenue_event_id (see
-- lib/experiment.ts), so these rows are reproducible from event ids alone.
create table if not exists experiment_assignments (
  id char(36) primary key,
  -- unique: a webhook retry must never flip an event between arms
  revenue_event_id char(36) not null unique,
  arm varchar(16) not null,
  policy_version varchar(32) not null,
  -- Economics recorded at decision time, so a later policy change cannot
  -- retroactively rewrite why this event was or wasn't acted on.
  recovery_probability decimal(6,5),
  expected_value_paise bigint,
  assigned_at datetime(3) not null default current_timestamp(3),
  constraint fk_assignment_event foreign key (revenue_event_id) references revenue_events(id)
) engine=InnoDB;

create index idx_revenue_events_customer on revenue_events(customer_id);
create index idx_agent_decisions_event on agent_decisions(revenue_event_id);
create index idx_agent_decisions_root_cause on agent_decisions(root_cause);
create index idx_recovery_actions_decision on recovery_actions(agent_decision_id);
create index idx_recovery_actions_executed on recovery_actions(executed_at);
create index idx_audit_log_event on audit_log(revenue_event_id, created_at);
create index idx_audit_log_stage on audit_log(stage);
create index idx_experiment_assignments_arm on experiment_assignments(arm);

-- Schema evolution. MySQL has no `add column if not exists`, so these are
-- written plainly and the migrator tolerates ER_DUP_FIELDNAME (1060) on
-- re-runs — see scripts/migrate.ts.
alter table agent_decisions add column from_cache tinyint(1) not null default 0;
alter table agent_decisions add column cache_key varchar(191);
