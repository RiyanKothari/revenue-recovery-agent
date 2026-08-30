# Revenue Recovery Agent

**Track 03: AI Revenue Recovery — Razorpay AI Buildathon 2026**

An agent that detects revenue-at-risk events (starting with failed payments), reasons over the root cause within hard-coded guardrails, and executes a bounded recovery workflow through Razorpay's own MCP server and WhatsApp — with every step logged to an audit trail.

This project is explicitly positioned as an explainable, audited layer on top of the failed-payment recovery pattern Razorpay validated in its own Sprint 2026 launch (WhatsApp re-engagement for failed autopay debits, UPI mandate retry) — not a generic recovery bot built from the brief alone.

## Architecture

```
Razorpay webhook (payment.failed)
        │  signature verified, deduped by event id
        ▼
Root-cause classifier (deterministic)
        │
        ▼
Guardrails — max retries / cooldown / DND / dispute kill-switch (deterministic, can veto everything downstream)
        │  only reachable if guardrails allow
        ▼
Agent decision (Claude, scoped to 3 pre-approved actions, must produce a rationale)
        │
        ▼
Action executor → Razorpay's official MCP server (payment link) + WhatsApp Cloud API
        │
        ▼
Outcome tracker (attributes recovery back to the triggering event)
        │
        ▼
Audit trail → Dashboard (live reasoning feed + batch summary), built on Razorpay's Blade design system
```

See `docs/DESIGN-DECISIONS.md` for why each of these choices was made — that doc is the source for the pitch video's "important decisions" section.

## Quick start
See `docs/SETUP.md` for the full walkthrough (Supabase, Razorpay test mode, WhatsApp, Anthropic key).

```
npm install
# fill in .env.local from .env.example
npm run dev
npm run seed:batch   # once webhooks are wired, populates the measured batch numbers
```

Dashboard: `/dashboard`

## Project structure
```
app/api/webhooks/razorpay/   the pipeline's entry point
app/api/batch-summary/       measured metrics for the dashboard
app/api/audit-feed/          live reasoning feed for the dashboard
app/dashboard/                the UI, built on @razorpay/blade
lib/                          classifier, guardrails, decision engine, MCP client, WhatsApp, audit
scripts/                      synthetic batch generator
supabase/schema.sql           full schema
docs/                         setup, architecture decisions, build challenges log
```

## Status
Scaffolded end-to-end for the primary loop (payment failure → recovery). Stretch: UPI mandate retry as a second trigger type. See `docs/BUILD-CHALLENGES.md` for what's been hit and fixed along the way.
