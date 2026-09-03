# Deploying the Recovery Desk

Everything needed to put this on the internet, in the order it has to happen.
Roughly 30 minutes, most of it waiting.

The repo is already deployable — no `vercel.json` is needed, because Next.js
is auto-detected and every database-touching route is `force-dynamic`, so the
build never needs a live connection. What follows is account setup, not code
changes.

---

## 1. Create the database (Supabase, free)

1. supabase.com → **New project**
   - Organisation: your existing one
   - Name: `revenue-recovery`
   - Region: **ap-south-1 (Mumbai)** — lowest latency to Razorpay's webhooks
   - Save the database password somewhere; it appears once

2. Wait for the project to finish provisioning (a couple of minutes).

3. **Take the POOLED connection string, not the direct one.**

   Settings → Database → Connection string → **Transaction pooler** (port
   `6543`), not Session or the direct `db.*.supabase.co:5432` URL.

   This matters more than it looks. Vercel runs each concurrent request in its
   own process, so a direct connection string means one pool per lambda, and a
   dozen simultaneous webhooks exhaust the free tier's connection limit. The
   failures then land on the guardrails, which fail closed — so the symptom of
   running out of connections is *the agent quietly refusing to act*, which is
   close to the hardest failure to diagnose from the dashboard.

   The pool size is already set to 1 connection per instance when `VERCEL` is
   present (`lib/db/postgres.ts`), but that only helps if the URL is pooled.

> ⚠️ Free-tier note: Supabase allows two active projects. You currently have
> `Huddle v1.0` active and `Nicheflow` inactive. If the new project is
> refused, pause `Nicheflow` rather than upgrading.

## 2. Create the schema

From your machine, with the pooled URL:

```bash
DATABASE_URL="<pooled-connection-string>" npm run db:migrate
```

Then confirm it took:

```bash
DATABASE_URL="<pooled-connection-string>" npm run preflight database
```

## 3. Deploy to Vercel

1. vercel.com → **Add New → Project** → import `RiyanKothari/revenue-recovery-agent`
2. Framework preset: **Next.js** (auto-detected). Leave build settings alone.
3. Add these environment variables **before** the first deploy:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the pooled Supabase URL from step 1 |
| `DECISION_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | from `.env.local` |
| `RAZORPAY_KEY_ID` | from `.env.local` |
| `RAZORPAY_KEY_SECRET` | from `.env.local` |
| `RAZORPAY_WEBHOOK_SECRET` | from `.env.local` |
| `RAZORPAY_MCP_MERCHANT_TOKEN` | from `.env.local` |
| `RAZORPAY_MCP_LINK_BUDGET` | `0` until you have a fresh test key |
| `WHATSAPP_DRY_RUN` | `true` |

**Do not set `ANTHROPIC_API_KEY`.** It is unused (`DECISION_PROVIDER` selects
Gemini) and putting an unfunded key in the environment adds a way to be
billed for nothing.

4. Deploy.

## 4. Verify before you trust it

```bash
curl https://<your-app>.vercel.app/api/health
```

Expected:

```json
{"status":"ok","database":{"driver":"postgres","reachable":true,"missing_tables":[]}}
```

A `503` with `missing_tables` means step 2 did not run against this database.
A `503` with `reachable: false` means the connection string is wrong. The
endpoint distinguishes the two deliberately, because they are the two ways a
fresh deployment is broken and they need different fixes.

## 5. Seed the deployed instance

The dashboard is empty until events exist. Point the batch at the deployed
webhook:

```bash
WEBHOOK_URL="https://<your-app>.vercel.app/api/webhooks/razorpay" \
DATABASE_URL="<pooled-connection-string>" \
npm run seed:batch 1200
```

1,200 events is deliberate: at the default 10% holdout it puts roughly 100
events in the control arm, which is enough to resolve the effect the batch
simulates. Smaller batches produce a real but statistically inconclusive
result, and the lift panel will correctly say so rather than overclaim.

Expect ~40 minutes. Decision caching means it costs almost no model calls —
the last 1,200-event run made 11.

## 6. Register the webhook with Razorpay

Dashboard → **Test mode** → Settings → Webhooks → Add New Webhook

- URL: `https://<your-app>.vercel.app/api/webhooks/razorpay`
- Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
- Active events: `payment.failed`, `payment.captured`, `order.paid`,
  `refund.created`, `payment.dispute.created`

The secret must match exactly. If it is blank or wrong the pipeline refuses
every delivery — deliberately, since an empty secret would otherwise accept
forged webhooks (`lib/verify-webhook.ts`).

---

## Known limitations of the deployed instance

Stated here rather than discovered during judging.

- **WhatsApp sends are dry-run.** The access token expired; Meta's API Setup
  tokens last ~24 hours. A System User token (Business Settings → System
  Users → Generate token, no expiry) fixes it permanently.
- **Payment links are simulated.** The test account has spent all 30 of its
  lifetime links. A fresh test key plus `RAZORPAY_MCP_LINK_BUDGET=25` makes
  the first 25 real. Simulated links are labelled as such on the ledger.
- **The batch is synthetic.** Recoveries are generated from a stated
  assumption, which the dashboard says on screen. The measurement machinery
  is real; the customer behaviour is not.

## If the demo has to survive without the internet

The whole stack runs locally:

```bash
docker compose up -d && npm run db:migrate && npm run seed:batch 1200 && npm run dev
```

Worth having ready. Conference wifi is the most likely thing to break on the
day, and it is the one failure that makes everything else irrelevant.
