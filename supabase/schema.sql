-- Revenue Recovery Agent — Core Schema
-- Every table here maps directly to a submission requirement:
--   revenue_events   -> the normalized "revenue-at-risk" trigger, deduped by Razorpay event id
--   agent_decisions  -> the agent's reasoning + chosen action (this IS the explainability layer)
--   recovery_actions -> what was actually sent/executed, and through which channel
--   outcomes         -> whether the money actually came back, and when
--   audit_log        -> append-only trail joining all of the above, queried by the dashboard
--   customer_consent  -> DND/opt-out state, enforced by guardrails before any action fires

create table if not exists revenue_events (
  id uuid primary key default gen_random_uuid(),
  razorpay_event_id text unique not null,          -- dedupe key: idempotency, non-negotiable
  event_type text not null,                        -- 'payment.failed' | 'payment.authorized' | 'order.paid' | 'checkout.abandoned'
  razorpay_payment_id text,
  razorpay_order_id text,
  amount_paise bigint not null,
  currency text not null default 'INR',
  error_code text,
  error_description text,
  payment_method text,                              -- 'card' | 'upi' | 'netbanking' | 'wallet'
  customer_id text,
  customer_contact text,                             -- phone, for WhatsApp nudges
  root_cause text,                                   -- filled by the classifier
  raw_payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists agent_decisions (
  id uuid primary key default gen_random_uuid(),
  revenue_event_id uuid references revenue_events(id) not null,
  root_cause text not null,
  chosen_action text not null,                        -- 'send_retry_link_whatsapp' | 'send_retry_link_email' | 'escalate_human' | 'no_action_within_cooldown'
  rationale text not null,                             -- the agent's written reasoning — this is the explainability artifact
  bounded_by text[] not null default '{}',             -- which guardrails constrained this decision, e.g. {'max_retries','cooldown'}
  model text not null default 'claude',
  decided_at timestamptz not null default now()
);

create table if not exists recovery_actions (
  id uuid primary key default gen_random_uuid(),
  agent_decision_id uuid references agent_decisions(id) not null,
  channel text not null,                               -- 'whatsapp' | 'email' | 'sms' | 'human_escalation'
  action_type text not null,                            -- 'retry_link_sent' | 'nudge_sent' | 'escalated'
  razorpay_payment_link_id text,                         -- from the Razorpay MCP server call
  status text not null default 'sent',                   -- 'sent' | 'failed' | 'skipped_guardrail'
  attempt_number int not null default 1,
  executed_at timestamptz not null default now()
);

create table if not exists outcomes (
  id uuid primary key default gen_random_uuid(),
  -- unique: order.paid can be delivered more than once, and double-counting
  -- here would inflate the headline "amount recovered" number
  revenue_event_id uuid references revenue_events(id) not null unique,
  recovered boolean not null default false,
  recovered_amount_paise bigint,
  recovered_payment_id text,
  attribution_window_minutes int not null default 60,
  resolved_at timestamptz
);

create table if not exists customer_consent (
  customer_id text primary key,
  whatsapp_opt_in boolean not null default true,
  email_opt_in boolean not null default true,
  dnd boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Append-only audit trail. This is what the dashboard's "live feed" queries directly.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  revenue_event_id uuid references revenue_events(id) not null,
  stage text not null,                                  -- 'event_received' | 'classified' | 'agent_decided' | 'action_executed' | 'stopping_rule_triggered' | 'outcome_recorded'
  detail jsonb not null,
  created_at timestamptz not null default now()
);

-- Experiment assignment. A slice of otherwise-eligible events is deliberately
-- left untreated so recovery can be MEASURED against a do-nothing baseline
-- rather than merely attributed. Kept in its own table, not as a column on
-- revenue_events, because an assignment belongs to an experiment and a policy
-- version, and the trigger record shouldn't be coupled to whichever
-- experiment happened to be running.
--
-- Assignment is a pure function of revenue_event_id (see lib/experiment.ts),
-- so these rows are reproducible from the event ids alone — the table is an
-- audit convenience, not the source of truth.
create table if not exists experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  -- unique: a webhook retry must never flip an event between arms
  revenue_event_id uuid references revenue_events(id) not null unique,
  arm text not null,                                    -- 'treated' | 'control'
  policy_version text not null,
  -- Economics recorded at decision time, so a later policy change can't
  -- retroactively rewrite why this event was or wasn't acted on.
  recovery_probability numeric,
  expected_value_paise bigint,
  assigned_at timestamptz not null default now()
);

create index if not exists idx_experiment_assignments_arm on experiment_assignments(arm);
create index if not exists idx_revenue_events_customer on revenue_events(customer_id);
create index if not exists idx_agent_decisions_event on agent_decisions(revenue_event_id);
create index if not exists idx_recovery_actions_decision on recovery_actions(agent_decision_id);
create index if not exists idx_audit_log_event on audit_log(revenue_event_id, created_at);
