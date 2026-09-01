# Setup

Five things need to exist before `npm run dev` does anything useful. Do them in this order.

## 1. Install dependencies
```
npm install
```

The repo ships an `.npmrc` with `legacy-peer-deps=true` — this is required, not incidental. `@razorpay/blade` declares `react-native` as a peer, and current React Native demands React 19 while this app is on React 18; without the flag npm aborts with `ERESOLVE`. The React Native code path is never bundled by Next.

Two dependency constraints are load-bearing and easy to "helpfully" break:

- **`styled-components` must stay on v5.** Blade v12 pins `styled-components@^5`. On v6 everything compiles and then dies at render time with a bare `TypeError: t is not a function`.
- **Blade's web peers must be installed explicitly** — `framer-motion`, `react-hot-toast@2.4.1`, `@razorpay/i18nify-js`, `@razorpay/i18nify-react`. `legacy-peer-deps` silently skips them, and the build fails with `Module not found: Can't resolve 'framer-motion'`.

Verify the install before going further:
```
npm test && npm run build
```

## 1b. Verify your credentials before running anything

Once `.env.local` is filled in, run:
```
npm run preflight
```

This checks all five services and names exactly what is wrong with each — missing env vars, missing database tables, bad Razorpay keys, a merchant token generated with a trailing newline, an expired WhatsApp token, no Anthropic credit. It exits non-zero if anything blocking fails.

Run it before `npm run seed:batch`. A misconfigured service otherwise surfaces as a confusing failure deep inside the webhook rather than as "your key is wrong".

## 2. Database — PostgreSQL or MySQL/TiDB

Razorpay runs MySQL historically and PostgreSQL / Aurora PostgreSQL for newer transactional systems, so this project supports both. Pick one; nothing above `lib/db/` changes.

### Fastest: local, via Docker

No signup, no free-tier limits, works offline.

```
docker compose up -d postgres
```

Put this in `.env.local`:
```
DATABASE_URL=postgresql://rr:local@127.0.0.1:5432/revenue_recovery
```

To verify the MySQL implementation as well, `docker compose up -d mysql` and use:
```
DATABASE_URL=mysql://root:local@127.0.0.1:3306/revenue_recovery
```

### Hosted alternative

Any Postgres (Supabase, Neon, RDS, Aurora) or MySQL (TiDB Serverless, PlanetScale) works — copy its connection URI into `DATABASE_URL`.

**On Supabase specifically:** use the **connection pooler** string, not the direct one. Settings → Database → Connection string → select *Session pooler*. The direct `db.*.supabase.co` host is IPv6-only on the free tier, and `pg` will fail to connect from most home networks with an unhelpful timeout.

### Then, either way

```
npm run db:migrate
npm run preflight database
```

`db:migrate` applies `db/schema.postgres.sql` or `db/schema.mysql.sql` depending on the URL scheme — no `psql` or `mysql` client needed, and it is safe to re-run. `preflight database` reports the selected driver, whether the connection works, and any missing tables.

`DATABASE_DRIVER` only needs setting if your host hands out a URI whose scheme doesn't say which engine it is.

## 3. Razorpay test mode
1. Sign up / log in to the Razorpay Dashboard, switch to **Test Mode** (toggle top-left).
2. Settings → API Keys → generate a Test key. Copy `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Settings → Webhooks → Add New Webhook:
   - URL: your local tunnel URL (see step 5) + `/api/webhooks/razorpay`, or your deployed URL
   - Active events: `payment.failed`, `payment.authorized`, `order.paid`
   - Set a secret, copy it into `RAZORPAY_WEBHOOK_SECRET`
4. Generate the MCP merchant token:
   ```
   echo $RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET | base64
   ```
   Put the output in `RAZORPAY_MCP_MERCHANT_TOKEN`.

## 4. WhatsApp Cloud API
1. Meta for Developers → create an app → add the WhatsApp product.
2. Get a temporary access token + phone number ID from the app dashboard for `.env.local`.
3. Create and get approval for a message template named `payment_retry_nudge` with two body variables (amount, link) — template approval can take a few hours, start this early.

## 5. Local webhook tunnel
Razorpay needs a public URL to send webhooks to. Use ngrok or similar:
```
ngrok http 3000
```
Use the `https://...ngrok-free.app` URL as your webhook base in step 3.

## 6. Anthropic API key
Set `ANTHROPIC_API_KEY` — this powers the decision engine (`lib/decision-engine.ts`).

## Run it
```
npm run dev
```
Dashboard: http://localhost:3000/dashboard

## Seed the batch (for the measured metrics)
Once the app is running and webhooks are wired:
```
npm run seed:batch
```
This sends 800 synthetic failed-payment events through the real webhook route — not a shortcut — so the batch summary on the dashboard reflects the actual pipeline.
