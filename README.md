# Revenue Recovery Agent

**Track 03: AI Revenue Recovery — Razorpay AI Buildathon 2026**

An agent that detects revenue-at-risk events (starting with failed payments), reasons over the root cause within hard-coded guardrails, and executes a bounded recovery workflow through Razorpay's own MCP server and WhatsApp — with every step logged to an audit trail and measured against a real batch.

This project is explicitly positioned as the **explainability and audit layer** on top of the failed-payment recovery pattern Razorpay validated in its own Sprint 2026 launch (WhatsApp re-engagement for failed autopay debits, UPI mandate retry) — not a generic recovery bot built from the brief alone.

## What makes it bounded, not just prompted

The claim "explainable and gated" is enforced in code, not asked for in a system prompt:

- **Guardrails run before the agent is called**, and their result is a hard veto. The model is only ever asked *which* of three pre-approved actions fits — never *whether* to act.
- **Every safety check fails closed.** If a guardrail cannot be evaluated — a database error, an unreadable row, an unavailable count — the action is refused rather than allowed. A safety rule that cannot prove an action is safe does not permit it.
- **The action set is enforced twice**: by a JSON schema on the response, and again in code. Anything outside it — including a refusal, a truncated response, or unparseable output — becomes a human escalation, never an executed action.
- **Unrecognised failures are never guessed at.** The classifier routes anything it does not recognise straight to human review, which is also what keeps the dashboard's exception list honest.

Each veto writes a `stopping_rule_triggered` entry with a specific reason, so the exceptions list on the dashboard means something rather than being a generic "failed" bucket.

## Architecture

```
Razorpay webhook (payment.failed)
        │  signature verified (HMAC, timing-safe), deduped by x-razorpay-event-id
        ▼
Root-cause classifier (deterministic, fails closed on unknown reasons)
        │
        ▼
Guardrails — DND / max retries / cooldown / dispute kill-switch
        │  deterministic, vetoes everything downstream, fails closed
        ▼
Agent decision (Claude, scoped to 3 pre-approved actions, must produce a rationale)
        │
        ▼
Action executor → Razorpay's official MCP server (payment link) + WhatsApp Cloud API
        │
        ▼
Outcome tracker (attributes recovery back to the triggering event, 24h window)
        │
        ▼
Audit trail → Dashboard (live reasoning feed + measured batch summary), built on Blade
```

Every stage writes to `audit_log`. If a stage doesn't log, it didn't happen as far as the audit-trail requirement is concerned.

See `docs/DESIGN-DECISIONS.md` for why each choice was made — that doc is the source for the pitch video's "important decisions" section.

## Quick start

Full walkthrough in `docs/SETUP.md` (Supabase, Razorpay test mode, WhatsApp, Anthropic key).

```bash
npm install
```

Then fill in `.env.local` from `.env.example` and verify every external service before running anything:

```bash
npm run preflight
```

Preflight checks all five dependencies and names exactly what is misconfigured — env vars, Supabase tables, Razorpay REST auth, the MCP merchant token (including the trailing-newline mistake `echo` introduces), Claude model access, and WhatsApp credentials. It exits non-zero on anything blocking.

```bash
npm run dev
npm run seed:batch    # posts 55 synthetic events through the real webhook route
```

Dashboard: `/dashboard`

> **Before seeding with live WhatsApp credentials:** the synthetic batch uses plausible *real* Indian mobile numbers. Set `WHATSAPP_DRY_RUN=true` (the default in `.env.example`) or `WHATSAPP_TEST_RECIPIENT` to a number you control. The executor refuses seeded-looking recipients when neither is set.

## Tests

```bash
npm test
```

51 tests, no credentials required — the external dependencies are injected, so the safety rules are tested against simulated database failures and the send path is tested without contacting Razorpay or Meta.

Coverage is deliberately weighted toward the failure paths: guardrails under a total database outage, the classifier's fail-closed branch, webhook signature rejection, an agent response that is truncated or out of bounds, and a recovery action that cannot be recorded.

## Project structure

```
app/api/webhooks/razorpay/   the pipeline's entry point
app/api/batch-summary/       measured metrics for the dashboard
app/api/audit-feed/          live reasoning feed for the dashboard
app/dashboard/               the UI, built on @razorpay/blade
lib/                         classifier, guardrails, decision engine, MCP client, WhatsApp, audit
scripts/                     preflight checks, synthetic batch generator
tests/                       unit tests for every module on the critical path
supabase/schema.sql          full schema
docs/                        setup, design decisions, build challenges log
```

## Measurement honesty

The dashboard reports two recovery rates, because they answer different questions:

- `recovery_rate` — of everything that failed, how much came back. The business number.
- `recovery_rate_attempted` — of the events the agent actually acted on, how many converted. Excludes events it deliberately never touched, so the agent's performance can't be mistaken for the business's.

"Amount recovered" comes from the `outcomes` table, attributed from a real `order.paid` webhook back to the originating failure within a 24-hour window — not asserted from the fact that a message was sent.

## Status

The pipeline is implemented end to end and unit-tested throughout. `docs/BUILD-CHALLENGES.md` is a running log of what broke and how it was fixed — kept as it happened, not reconstructed.

Stretch, not started: UPI mandate retry as a second trigger type.
