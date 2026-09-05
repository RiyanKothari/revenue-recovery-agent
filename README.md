# Revenue Recovery Agent

An auditable agent for failed-payment recovery. It watches a Razorpay webhook
stream, classifies why each payment failed, decides within hard guardrails
whether and how to act, executes the recovery through Razorpay's own MCP server
and the WhatsApp Cloud API, and then proves both that the money came back
*because* it acted and that every safety rule held while it did.

**Live:** [Dashboard](https://revenue-recovery-agent-plum.vercel.app/dashboard)
· [Policy Lab](https://revenue-recovery-agent-plum.vercel.app/dashboard/policy)
· [Red Team](https://revenue-recovery-agent-plum.vercel.app/dashboard/redteam)
· [Health](https://revenue-recovery-agent-plum.vercel.app/api/health)

Deployed on Vercel (Mumbai) against Supabase Postgres (ap-south-1), the region
Razorpay's webhooks originate from.

---

## Contents

- [What it does](#what-it-does)
- [Results](#results)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Testing](#testing)
- [Verification](#verification)
- [Project structure](#project-structure)
- [Documentation](#documentation)

---

## What it does

Roughly a quarter of failed payments are recoverable. The card had no balance at
2pm and has one at 6pm; the bank timed out; the network dropped mid
authorisation. Sending a nudge is the easy part. The hard parts are reaching the
right person at a moment that helps without contacting someone who opted out,
and then proving the recovery was caused rather than coincidental.

Three properties distinguish this from a recovery bot:

**The agent is gated in code, not in a prompt.** Four guardrails (consent, retry
ceiling, cooldown, refund and dispute kill switch) and a deterministic expected
value gate run *before* the model is called, and their result is a hard veto.
The model is only ever asked *which* of three pre-approved actions fits, never
*whether* to act. Every check fails closed: a guardrail that cannot be
evaluated refuses rather than permits.

**Recovery is measured, not attributed.** A deterministic slice of otherwise
eligible events is left untreated as a holdout, so there is a do-nothing
baseline to compare against. The dashboard also reports the minimum detectable
effect, so an inconclusive result reads as "this experiment was too small to
tell" rather than "the agent did not work".

**The safety rules are provable after the fact.** An independent verifier
re-derives seven invariants from the recorded audit trail using code that shares
nothing with the guardrails that enforce them. It runs on demand and gates a
deploy.

---

## Results

Measured on the deployed instance, from a 1,206 event batch posted through the
real webhook route.

| | |
|---|---|
| Recovery rate | **25.7%** overall, 33.2% of events acted on |
| Measured lift vs holdout | **+21.0pp**, 95% CI [14.1, 27.9] |
| Incremental recovery | **₹7,56,982** |
| Safety conformance | **5,346 checks, 0 violations** across 7 invariants |
| Red team | 10 hostile inputs against live defences, all refused |
| Model economy | **11 model calls** served 908 decisions |
| Tests | **311**, including a 30 case dual-driver database contract suite |

The lift line is the only one that is a measurement rather than an attribution.
Everything above it credits the agent for customers who might have retried
unprompted; the gap between the treated arm and the holdout is recovery the
agent can claim to have caused.

**The batch is synthetic and the dashboard says so on screen.** Recoveries in it
are generated from a stated assumption, so the lift demonstrates the measurement
machinery working rather than evidencing real customer behaviour. Separately,
six genuine Razorpay `payment.failed` events have run through the deployed
instance, producing three real payment links through the MCP server and a
WhatsApp message that was delivered.

---

## Architecture

```
Razorpay webhook (payment.failed)
        │  HMAC verified timing-safe, deduped on x-razorpay-event-id
        ▼
Root cause classifier            reads error_reason / error_source, fails closed
        │
        ▼
Guardrails                       DND · retry ceiling · cooldown · dispute kill switch
        │                        deterministic, hard veto, fails closed
        ▼
Expected value gate              is acting worth it, not merely permitted
        │
        ▼
Experiment assignment            a holdout slice stops here, forming the baseline
        │
        ▼
Agent decision                   scoped to 3 approved actions, must produce a rationale
        │                        memoised on the situation, never on the event
        ▼
Send window                      channel is the agent's; the hour is policy
        │
        ▼
Action executor                  Razorpay MCP server (payment link) + WhatsApp Cloud API
        │
        ▼
Outcome tracker                  attributes order.paid back to the failure, 24h window
        │
        ▼
audit_log ──► Dashboard · Conformance verifier · Policy Lab replay
```

Every stage writes to `audit_log`, which is append-only: nothing in the codebase
updates or deletes from it, so the record of what the agent did cannot be
rewritten afterwards. It is also event-shaped, so at production volume the
dashboard would read a CDC stream rather than polling the transactional store.

---

## Tech stack

**Application**

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 14 (App Router) | One deployable for the webhook receiver, the API and the dashboard |
| Language | TypeScript 5.5 (strict) | The safety rules are types where they can be, e.g. `dndRespected: true` is a literal so no future policy can relax consent |
| UI system | [`@razorpay/blade`](https://blade.razorpay.com) v12 | Razorpay's own design system, on `styled-components` 5 |
| Localisation | `@razorpay/i18nify-js` | Required by Blade: its PhoneNumberInput imports it, so the barrel export needs it present |
| Motion | `framer-motion` | Feed transitions, reduced-motion aware |
| Validation | `zod` | Model responses are schema-validated before they are trusted |

**Data**

| Layer | Choice | Why |
|---|---|---|
| Primary store | PostgreSQL via `pg` | Runs on Supabase, RDS or Aurora PostgreSQL |
| Alternate store | MySQL / TiDB via `mysql2` | Razorpay's published stack uses MySQL historically |
| Abstraction | Repository interface in `lib/db/` | Nothing above it knows which engine is in use; the driver is inferred from the `DATABASE_URL` scheme |
| Migrations | `scripts/migrate.ts` | Idempotent, driver-aware, no psql or mysql client needed |

Both drivers run the same 30 case contract suite and are asserted to agree.

**Agent and execution**

| Layer | Choice | Why |
|---|---|---|
| Model | Gemini, or Anthropic Claude | Behind a provider-agnostic adapter; `DECISION_PROVIDER` selects explicitly rather than by sniffing which key exists |
| Tool execution | [Razorpay MCP server](https://mcp.razorpay.com/mcp) (42 tools) | The app is itself an MCP client, over `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` |
| Messaging | WhatsApp Cloud API (Meta Graph) | Template messages, with an inbound delivery-status callback |
| Decision cost | Memoisation keyed on the decision *situation* | 11 model calls served 908 decisions |

**Infrastructure**

| Layer | Choice |
|---|---|
| Hosting | Vercel, `bom1` (Mumbai) |
| Database | Supabase Postgres, `ap-south-1`, transaction pooler on 6543 |
| Scheduling | Vercel Cron, bearer-authenticated dispatch endpoint |
| CI | GitHub Actions: typecheck, test suite, production build |
| Local dev | Docker Compose (Postgres + MySQL) |
| Test runner | Node's built-in runner via `tsx`, no framework |

---

## Quick start

```bash
npm install
docker compose up -d postgres
npm run db:migrate
cp .env.example .env.local     # then fill it in
npm run preflight
npm run dev
```

`preflight` checks every external dependency and names exactly what is
misconfigured: environment variables, the database connection and schema,
Razorpay REST auth, the MCP merchant token (including the trailing newline that
`echo` introduces), the configured decision provider, and WhatsApp credentials
including the template's approval status and language code. It exits non-zero on
anything blocking.

Seed a measurable batch through the real webhook route:

```bash
npm run seed:batch 1200
```

> **Before seeding with live WhatsApp credentials.** The synthetic batch uses
> plausible real Indian mobile numbers. Dry run is the default *in code*:
> sending requires an explicit `WHATSAPP_DRY_RUN=false`, so a blank or malformed
> value logs instead of sending. Set `WHATSAPP_TEST_RECIPIENT` to a number you
> control first. The executor refuses seeded-looking recipients when neither is
> set.

Full walkthrough in [`docs/SETUP.md`](docs/SETUP.md). Deployment in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Configuration

All variables are documented in [`.env.example`](.env.example). The ones that
change behaviour rather than merely enabling it:

| Variable | Default | Effect |
|---|---|---|
| `DATABASE_URL` | none | `postgres://` or `mysql://`; the scheme picks the driver |
| `DECISION_PROVIDER` | none | `gemini` or `anthropic`. Refuses to guess when both keys are present |
| `WHATSAPP_DRY_RUN` | `true` | Anything other than an explicit `false` logs instead of sending |
| `SCHEDULED_SENDS` | `true` | `false` sends everything immediately, ignoring send windows |
| `RAZORPAY_WEBHOOK_SECRET` | none | Unset refuses **every** webhook; an empty HMAC key would otherwise verify forgeries |
| `WHATSAPP_APP_SECRET` | none | Unset refuses every delivery callback, for the same reason |
| `CRON_SECRET` | none | Unset refuses to dispatch scheduled sends |

The last three are deliberate: several guards in this system treat "not
configured" as "refuse", because the alternative is a deployment that looks
secure and is not.

---

## Testing

```bash
npm test
```

311 tests, no credentials required. Every module that touches an external
service takes it as an injected dependency, so the safety rules are tested
against simulated database outages and the send path is tested without
contacting Razorpay or Meta.

Coverage is weighted toward failure paths: guardrails under a total database
outage, the classifier's fail-closed branch, webhook signature rejection
(including a signature forged with an empty key), a truncated or out-of-bounds
model response, a recovery action that cannot be recorded, and concurrent
webhook redeliveries racing for the same event.

The dual-driver contract suite in `tests/db-contract.test.ts` runs the same 30
case sequence against PostgreSQL and MySQL and asserts they agree. It skips
rather than fails when no database is reachable, so the suite still runs without
Docker.

---

## Verification

```bash
npm run verify
```

Guardrails *enforce* the rules at run time. This *proves* they held afterwards,
by re-deriving seven invariants from what was actually recorded:

| | Invariant |
|---|---|
| I1 | No customer with DND set was ever contacted |
| I2 | No event exceeded the retry ceiling |
| I3 | No customer was contacted twice inside the cooldown |
| I4 | Every decision chose an action from the permitted set |
| I5 | Every decision carries a written rationale |
| I6 | No holdout control event was ever acted on |
| I7 | Every executed action traces to an authorising decision |

`lib/invariants.ts` **shares no code with the enforcement path**. It restates
each rule independently rather than importing the constants `lib/guardrails.ts`
uses, because a verifier built on the same logic would pass its own check and
the exercise would be a tautology. Two independent expressions of the same
invariant have to agree, or something is wrong.

The command exits non-zero on any violation, so it can gate a deploy. It refuses
outright above 50,000 events rather than verifying a subset: a safety
attestation over part of the record is a clean bill of health for rows nobody
looked at.

---

## Project structure

```
app/
  api/webhooks/razorpay/     pipeline entry point
  api/webhooks/whatsapp/     Meta delivery-status callback
  api/cron/dispatch/         drains the scheduled-send queue
  api/conformance/           machine-checked invariants and what the rules cost
  api/replay/                counterfactual policy replay
  api/redteam/               hostile inputs against the live defences
  dashboard/                 the UI, built on Blade
lib/
  classifier.ts              root cause, from Razorpay's structured error fields
  guardrails.ts              consent, retry ceiling, cooldown, dispute kill switch
  expected-value.ts          the economic gate
  experiment.ts              deterministic holdout assignment
  decision-engine.ts         the bounded agent
  decision-cache.ts          memoisation keyed on the situation
  send-window.ts             quiet hours and payday deferral
  razorpay-mcp-client.ts     MCP client
  whatsapp.ts                Cloud API send path
  invariants.ts              the independent verifier
  db/                        repository interface + postgres and mysql drivers
tests/                       311 tests
db/                          PostgreSQL and MySQL schemas
scripts/                     preflight, migrate, verify, batch generator
```

---

## Documentation

| | |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Local setup, Razorpay test mode, WhatsApp, model provider |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Vercel and Supabase, environment, webhook registration |
| [`docs/DESIGN-DECISIONS.md`](docs/DESIGN-DECISIONS.md) | Why each choice was made, and what was rejected |
| [`docs/BUILD-CHALLENGES.md`](docs/BUILD-CHALLENGES.md) | A running log of what broke and how it was fixed, kept as it happened |

---

Built for Track 03, AI Revenue Recovery, Razorpay AI Buildathon 2026.
