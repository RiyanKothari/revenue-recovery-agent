# Build Challenges

Razorpay's stated evaluation explicitly asks what broke and how you recovered. Log entries here AS THEY HAPPEN, not reconstructed at the end — specific and real beats generic and polished for this section.

Format per entry:
```
## [date] — [short title]
**What broke:**
**Why:**
**Fix:**
```

<!-- Start logging below. Don't delete this template. -->

## 2026-08-30 — `npm install` refused to resolve Blade's dependency tree

**What broke:** A clean `npm install` failed outright with `ERESOLVE unable to resolve dependency tree`.

**Why:** `@razorpay/blade` is a cross-platform (web + React Native) component library. It declares `react-native` as a peer dependency, and the current `react-native@0.87` demands `react@^19.2.3`, while this project is on React 18. npm treats that as an unsatisfiable conflict even though the React Native code path is never bundled by Next.js.

**Fix:** Installed with `--legacy-peer-deps` and committed a `.npmrc` with `legacy-peer-deps=true` so the next person cloning the repo doesn't hit the same wall.

## 2026-08-30 — Blade's theme export doesn't exist under the name the docs implied

**What broke:** `import { paymentTheme } from "@razorpay/blade/tokens"` — TypeScript error TS2305, no such export.

**Why:** Blade v12 renamed its theme tokens. The exports are now `bladeTheme` and `bladeNeutralTheme`; `paymentTheme` was the pre-v12 name.

**Fix:** Read the actual export list out of `node_modules/@razorpay/blade/build/types/tokens/index.d.ts` rather than guessing again, and switched to `bladeTheme`. `BladeProvider`'s props (`themeTokens`, `colorScheme`) were unchanged.

## 2026-08-30 — Blade broke every page at build time via the root layout

**What broke:** `next build` compiled successfully, then died during page-data collection: `TypeError: (0, N.createContext) is not a function`, on `/_not-found` of all things.

**Why:** `BladeProvider` was being imported directly into `app/layout.tsx`. In the Next.js App Router a layout is a **server** component by default, and Blade is built on React context and styled-components — neither of which exists server-side. Because it was in the root layout, it poisoned every route, including ones we never wrote.

**Fix:** Moved the provider into `app/providers.tsx` behind a `"use client"` boundary, and added a styled-components SSR registry (`ServerStyleSheet` + `useServerInsertedHTML`) so the first paint isn't unstyled. Added `next.config.js` with `compiler.styledComponents` and `transpilePackages: ["@razorpay/blade"]`.

## 2026-08-30 — Blade renders blank on styled-components v6

**What broke:** After fixing the layout, the build got further and then failed prerendering `/dashboard` with a bare `TypeError: t is not a function` inside a minified chunk — no useful stack.

**Why:** The project had `styled-components@6`, but Blade v12's `peerDependencies` pin `styled-components@^5`. v6 changed internal APIs Blade still calls. It compiles fine — the failure only appears at render.

**Fix:** Downgraded to `styled-components@^5` plus `@types/styled-components`. Also installed the web-side peers `--legacy-peer-deps` had silently skipped: `framer-motion`, `react-hot-toast@2.4.1`, `@razorpay/i18nify-js`, `@razorpay/i18nify-react`. Build passed and the dashboard rendered.

**Lesson:** `--legacy-peer-deps` unblocks the install but stops telling you about genuinely required peers. Worth reading `peerDependencies` directly after using it.

## 2026-08-30 — The "live" dashboard was frozen at build time

**What broke:** Not an error — the build output showed `○ (Static)` next to `/api/audit-feed` and `/api/batch-summary`.

**Why:** Next.js statically prerenders route handlers that don't use dynamic functions. Both handlers just query Supabase, so Next evaluated them once at build and cached the result. The dashboard polls every 4 seconds and would have received the same build-time snapshot forever — the live reasoning feed would never have advanced during the demo.

**Fix:** Added `export const dynamic = "force-dynamic"` to both handlers. Build output now shows `ƒ (Dynamic)` for all three routes.

**Lesson:** This one is dangerous precisely because it isn't an error. Read the route table in the build output, not just the exit code.

## 2026-08-30 — Recovery attribution was never wired up

**What broke:** `attributeRecovery()` in `lib/outcome-tracker.ts` was fully implemented and called from nowhere.

**Why:** The webhook handler only processed `payment.failed`. Nothing listened for the *success* side, so the `outcomes` table was never written to.

**Fix:** Added an `order.paid` / `payment.captured` branch to the webhook that calls `attributeRecovery`. Also added a `unique` constraint on `outcomes.revenue_event_id` and 23505 handling, since Razorpay can deliver the same success event more than once and double-counting would have inflated the headline number.

**Impact if missed:** "Recovered" and "Recovery rate" — the two numbers the submission is actually judged on — would have displayed ₹0 and 0.0% no matter how well the agent performed.

## 2026-08-30 — Idempotency key came from a field Razorpay doesn't send

**What broke:** Nothing, in testing — which was the problem.

**Why:** The webhook deduplicated on `payload.id`. Razorpay's `payment.failed` body has no top-level `id`; the event id ships in the **`x-razorpay-event-id` header**. The synthetic batch generator invented a matching `id` field in the body, so the seeded demo passed while every real webhook would have hit `400 malformed_payload`.

**Fix:** Read `x-razorpay-event-id` from the headers, falling back to the payment id. Changed the generator to send the value as a header instead of inventing a body field, so the synthetic path exercises the same code as production.

**Lesson:** A test fixture that invents a field the real producer never sends will pass forever and prove nothing.

## 2026-08-30 — WhatsApp nudges would have contained dead links

**What broke:** The retry link was constructed as `https://rzp.io/l/${paymentLinkId}`.

**Why:** That URL was assembled by hand from the payment-link **id** (`plink_...`). Razorpay returns the real customer-facing URL as `short_url` on the payment-link object, and the MCP client was discarding it.

**Fix:** Returned `short_url` from `createAndSendRetryLink` and used it in the WhatsApp message.

**Impact if missed:** Every recovery message would have shipped a 404. The pipeline would have reported success end-to-end while recovering nothing.

## 2026-08-30 — Root-cause classification silently mislabelled network failures

**What broke:** A unit test written for the classifier failed on its first run: a "Network connection error during authorization." event classified as `gateway_error` instead of `network_drop`.

**Why:** `classify()` concatenated `error_code` and `error_description` into one string and ran the rules against the blob. Razorpay's `error_code` is a coarse bucket (`GATEWAY_ERROR`, `BAD_REQUEST_ERROR`, `SERVER_ERROR`) while the description carries the actual reason. The regex `/(gateway|processing).?error/` matched the literal string `GATEWAY_ERROR` in the *code* and returned before the description was ever considered — making `network_drop` effectively unreachable for any event Razorpay tagged `GATEWAY_ERROR`.

**Fix:** Rewrote `classify()` to try the specific `error_description` first and fall back to the coarse `error_code` only if nothing matched.

**Impact if missed:** The dashboard's "breakdown by root cause" — a graded output — would have been quietly wrong, and the agent would have reasoned from a wrong premise on a whole class of failures.

**Lesson:** This is the bug that justified writing tests at all. It produced no error and plausible-looking output; only an assertion about a specific expected category surfaced it.

## 2026-08-30 — Every guardrail failed OPEN on a database error

**What broke:** Nothing visibly — found while reading `lib/guardrails.ts` to write tests for it.

**Why:** All four checks destructured only `{ data }` and discarded `error`. On any Supabase failure the query returned `data: null`, so `consent?.dnd` was falsy, `attemptCount ?? 0` became `0`, and `recentActions` was empty — every single rule evaluated to "allowed". A database blip would have silently disabled DND opt-outs, the retry ceiling, the cooldown, and the dispute kill-switch simultaneously, and the agent would have started nudging freely with no error anywhere.

**Fix:** Every check now inspects `error` and fails **closed** — if we cannot prove an action is safe, we don't take it. A null attempt count with no error is also treated as unproven rather than zero. Added 12 tests covering each rule plus a total-outage case that asserts `allowed: false`.

**Impact if missed:** The single worst failure mode in the project. "Bounded and compliant" is the actual grading criterion, and the guardrails would have been decorative under exactly the conditions they exist for.

**Lesson:** Fail-open is the default you get for free from `const { data } = await ...`. Safety code has to state its failure direction explicitly.

## 2026-08-30 — The database client threw at import time

**What broke:** The new guardrail tests crashed before running: `Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`, thrown from `lib/supabase.ts:1`.

**Why:** `lib/supabase.ts` validated env vars and called `createClient` at module scope. Any import of anything touching the database — including pure safety rules that now accept an injected client — executed that throw. It also explained why every `next build` had needed placeholder credentials: the build was importing route handlers, and the throw fired during collection.

**Fix:** Made the client lazy behind a `Proxy`, constructed on first property access. Imports are now side-effect free and the missing-key error surfaces when something actually queries.

**Impact if missed:** Beyond untestable safety code, a real deploy would have failed at **build** time on any platform where env vars are injected at runtime rather than build time.

## 2026-08-30 — "Avg. time to recovery" was divided by the wrong denominator

**What broke:** The average was silently too low.

**Why:** The reducer in `/api/batch-summary` skipped any recovery missing an event row or a `resolved_at` (returning the accumulator unchanged), but then divided the total by `recoveredEvents.length` — the full count, including the ones it had just skipped. Every skipped entry pulled the average toward zero.

**Fix:** Collect the durations it can actually compute with `flatMap`, then divide by that array's length. Also returns `timed_recoveries` so the number is auditable against the recovery count.

## 2026-08-30 — A failed dashboard query was indistinguishable from a failed agent

**What broke:** `/api/batch-summary` dropped `error` on all its queries, so a database failure rendered "Total at risk ₹0 · Recovered ₹0 · Recovery rate 0.0%".

**Why:** Same `const { data } = await ...` pattern as the guardrails bug. With `data` null, every downstream reduce produced a legitimate-looking zero.

**Fix:** The handler returns 500 on any query error. The dashboard already ignores non-200 and keeps its last good numbers, so an outage now reads as stale rather than as a working agent that recovered nothing.

**Impact if missed:** The worst possible demo failure — a screen confidently reporting total failure, with no indication anything was wrong.

## 2026-08-30 — One recovery rate was answering two different questions

**What broke:** Not a bug, a measurement honesty problem noticed while fixing the above.

**Why:** `recovery_rate` divided recoveries by *all* failed events, including ones with an unknown root cause that the classifier deliberately routes straight to human review and the agent never touches. That understates the agent while overstating what it attempted.

**Fix:** Report both. `recovery_rate` stays the business number (of everything that failed, how much came back); `recovery_rate_attempted` divides by events that actually reached `agent_decisions`. The dashboard shows both, so the agent's number can never be mistaken for the business's.

## 2026-08-30 — The write path could silently disable the read path's guardrails

**What broke:** Nothing observable — found while adding tests for `lib/action-executor.ts`.

**Why:** Every `recovery_actions` insert was fire-and-forget. That table is exactly what `guardrails.ts` counts to enforce the retry ceiling and the cooldown window. A failing insert meant the attempt count never advanced and the cooldown saw no recent nudge, so the same customer could be messaged indefinitely — the executor quietly switching off the guardrails by not writing the rows they read.

**Fix:** Inserts are checked. A failure writes a loud audit entry and throws, tagged so the surrounding catch can distinguish "the send failed" (record it as failed, carry on) from "the recording failed" (propagate). Throwing is safe because the webhook's idempotency check short-circuits Razorpay's retry on the existing `revenue_event`, so it cannot cause a second send.

**Also fixed:** a persistently failing MCP gateway previously recorded nothing on the error path in some orderings, which would have made the retry ceiling unreachable. There is now a test asserting a failed attempt is still counted.

## 2026-08-30 — `next build` failed with phantom missing-module errors

**What broke:** `PageNotFoundError: Cannot find module for page: /api/audit-feed`, then `Cannot find module .next/server/app/page.js`. Deleting `.next` and rebuilding did not help, which ruled out a stale cache.

**Why:** A `next dev` process from an earlier preview had survived being stopped and was still regenerating `.next` while `next build` wrote into the same directory. The two processes raced and the build read files the dev server had just replaced.

**Fix:** Killed the orphaned `next dev` (and its npm parent and Next server child), then rebuilt clean.

**Lesson:** On Windows especially, `next build` and `next dev` must not share a working directory. If a build fails with missing-module errors that survive `rm -rf .next`, check for a live dev server before touching any code — the error points at the app, but the cause is the process table.

## 2026-09-01 — The agent could crash the webhook on the path meant to be safe

**What broke:** Found while writing tests for `lib/decision-engine.ts`.

**Why:** `JSON.parse(textBlock.text)` was unguarded. The surrounding code was carefully written to fail closed — a refusal or an out-of-bounds action becomes a human escalation — but a `max_tokens` truncation returns a valid JSON *prefix*, which throws. That exception propagated out of the webhook handler as a 500 instead of degrading into an escalation, on the exact path designed to degrade safely.

**Fix:** Wrapped the parse, and required `rationale` to be a string before accepting the response — an action without a rationale is not a usable decision, since the rationale is the explainability artifact. Both cases now escalate.

## 2026-09-01 — `npm run seed:batch` would have failed on a correctly configured machine

**What broke:** The seed script reads `process.env.RAZORPAY_WEBHOOK_SECRET` and throws if it's absent.

**Why:** Next.js loads `.env.local` automatically, but a standalone `tsx` script does not. Nothing in the script's process had ever read the file, so the batch generator would have thrown "RAZORPAY_WEBHOOK_SECRET not set" on a machine where everything was set correctly — the most misleading possible error.

**Fix:** Added a dependency-free `scripts/load-env.ts` and called it from the script. Existing environment variables win over the file so shell and CI overrides still behave predictably. Covered with tests for the cases that would silently corrupt a secret: base64 `=` padding, a `#` inside a value, and quoted values.

## 2026-09-01 — Blade constrains what can go inside its components

**What broke:** `TS2322: Property 'className' does not exist` on `Box`, and `Type 'Element' is not assignable to type 'ReactText'` on `Badge`.

**Why:** Blade's `Box` doesn't accept `className`, and `Badge` accepts text-only children. The design spec calls for a monospaced face on headings and timestamps and a status dot inside the live pill — both of which assume you can nest arbitrary elements inside Blade components.

**Fix:** Inverted the nesting. Styled wrappers go *around* Blade components (`<span className="rr-mono"><Text/></span>`), with a descendant CSS selector reaching the element Blade renders. The status dot became a sibling of the badge inside a flex `Box` rather than a child of it.

**Lesson:** A design system that constrains its own component API is doing its job. Work around it at the boundary rather than fighting it from inside.

## 2026-09-01 — The batch size made the headline measurement meaningless

**What broke:** Nothing technically — the holdout arm worked on the first run. The problem was that it couldn't say anything.

**Why:** The synthetic batch was 55 events. With a 10% holdout that's ~5 control events, and a conversion rate estimated from 5 observations has a confidence interval so wide it spans almost every plausible value. The measurement existed but carried no information.

**Fix:** Made the batch size configurable and raised the default to 800, giving ~80 control events. Also made `computeLift` refuse to report confidently below 30 per arm — it returns a caveat saying the result is directional rather than printing an interval that looks authoritative.

**Lesson:** Adding a control group is the easy half. Sizing it so the comparison can actually resolve the effect is the half that decides whether the number means anything. A rigorous method at the wrong sample size is still just a number.

## 2026-09-01 — Deliberate non-actions were being displayed as failures

**What broke:** The holdout control events and the negative-expected-value skips appeared in the dashboard's "Exceptions — could not resolve" list.

**Why:** Both write a `stopping_rule_triggered` audit entry, which the exceptions panel reads wholesale. Structurally they *are* stopping rules, so the query was right.

**Fix:** Split the panel. Genuine failures (DND, cooldown, retry ceiling, unrecognised cause) stay under "could not resolve"; holdout and negative-EV move to "Declined on purpose" with an informational badge rather than a negative one.

**Impact if missed:** It would have read as the agent failing on ~15% of the batch when it was in fact making deliberate, correct decisions — understating the system while looking like a defect. The distinction between "couldn't" and "chose not to" is most of the judgment on display here.

## 2026-09-01 — The conformance verifier nearly checked a fraction of the batch and reported a clean pass

**What broke:** Caught while writing `lib/conformance-store.ts`, before it ever ran against real data.

**Why:** PostgREST caps a plain `select` at 1000 rows. An 800-event batch writes several thousand `audit_log` entries and well over a thousand decisions and actions. A straightforward read would have silently returned the first 1000 rows, and the verifier would have checked a slice of the batch and reported "all invariants held" — a confident, wrong attestation from the one component whose entire job is to be trustworthy.

**Fix:** Paginated reads via `.range()` for every table the verifier loads, continuing until a short page comes back.

**Lesson:** A silent truncation is bad anywhere; in a verifier it's worse than having no verifier at all, because it manufactures false confidence. Anything that attests to a property must read the whole population or refuse to answer.

## 2026-09-01 — TypeScript caught a union the tests couldn't

**What broke:** `tsc` rejected the `flatMap` building the verifier's resolved-action index — two branches returning different shapes, so the element type collapsed to `unknown` and every downstream property access failed.

**Why:** `flatMap` widened the union badly across branches where one returned `{decision: null}` and the other `{decision: Decision}`.

**Fix:** Declared the `ResolvedAction` type explicitly and used `map`, since each input produced exactly one output anyway.

**Worth noting:** all 91 tests passed while this was broken — `tsx` strips types without checking them. `npm test` and `npx tsc --noEmit` catch genuinely different classes of bug, and the build only runs the latter.

## 2026-09-01 — A half-processed event could never be retried

**What broke:** Found reviewing the webhook before the first real batch run.

**Why:** The dedupe check treated *any* known `razorpay_event_id` as a finished duplicate. But the row is inserted at the very start of the pipeline, before classification, the agent call, or execution. If the first delivery inserted the row and then died — an Anthropic timeout, a transient database error, a cold-start deadline — every subsequent Razorpay retry returned `duplicate_ignored`. The event was never decided, never actioned, and never appeared as an exception. It silently vanished.

**Fix:** The marker for "already handled" is now an `agent_decisions` row rather than the event's existence. `decide()` writes that row before any send happens, so if one exists a re-run could double-contact the customer, and if it doesn't, resuming is safe. Everything after the insert moved into `processEvent()` so a resumed delivery runs the identical path rather than a second, subtly different one. A `23505` on insert (two concurrent deliveries racing past the check) is now treated as a duplicate rather than a 500.

**Impact if missed:** Silent event loss under exactly the conditions an 800-event batch with an LLM call in the path will produce. The dashboard would have shown a smaller batch than was sent, with nothing anywhere explaining the gap.

## 2026-09-01 — Consent failed open when the payload had no customer identifier

**What broke:** `customerId` is `paymentEntity.customer_id ?? paymentEntity.contact`. If a payload carried neither, it was `undefined`.

**Why:** The DND lookup then queried for an undefined customer, matched no rows, and `consent?.dnd` evaluated falsy — indistinguishable from "this customer has opted in". The one rule with no exceptions was skippable by omitting a field. The conformance verifier couldn't catch it either, since I1 keys on `customer_id` and skips events without one.

**Fix:** The pipeline now refuses outright when there is no identifier: consent cannot be verified, so no contact is made.

**Lesson:** Fail-closed has to cover missing *inputs*, not just failing queries. An absent identifier reads as an empty result set, and an empty result set reads as permission.

## 2026-09-01 — The synthetic batch couldn't trigger three of the four guardrails

**What broke:** Every event in the batch had its own customer (`cust_synthetic_${i}`), and no `customer_consent` rows were seeded at all.

**Why:** The cooldown rule needs the same customer contacted twice; the retry ceiling needs repeated attempts on one event; DND needs a consent row saying so. With a unique customer per event and an empty consent table, none of those conditions could ever arise. The batch would run clean, the exceptions list would show only non-recoverable events and holdout controls, and conformance invariants I1–I3 would pass **vacuously** — verifying rules that were never exercised.

**Fix:** 25% of events now reuse an earlier customer (deterministically, so re-runs reproduce), contact numbers follow the customer rather than the event index, and the script seeds `customer_consent` with ~5% of the pool opted out before posting any events. Added tests asserting the batch actually contains repeats and a non-empty opted-out set.

**Lesson:** The most dangerous test fixture isn't one that fails — it's one that passes without exercising the thing it claims to test. "All invariants held" across a batch that couldn't violate them is a statement about the fixture, not the system.


## 2026-09-01 — Made the pipeline run on PostgreSQL *and* MySQL

**What broke:** Nothing — this was a deliberate migration, logged because it was the largest single refactor in the build and it surfaced real engine differences.

**Why:** Razorpay's published stack runs MySQL historically and PostgreSQL / Aurora PostgreSQL for newer transactional systems. The pipeline was written against Supabase's PostgREST query builder, which is neither SQL nor portable — 41 call sites, five `!inner` joins with no MySQL equivalent, a `jsonb` containment query behind the dispute kill-switch, and Postgres error code `23505` hard-coded into the idempotency and attribution paths.

**Fix:** Introduced a repository interface (`lib/db/types.ts`) expressed as domain operations — "has this customer been contacted recently?" rather than a query — with two implementations over `pg` and `mysql2`. Nothing above that layer knows which engine is in use.

**The differences that actually mattered:**

- MySQL has neither `gen_random_uuid()` defaults nor `RETURNING`, so there is no way to learn the id of a row you just inserted without a second round trip. Ids are now generated in the application, which keeps inserts single-shot on both engines.
- Unique violations are `23505` on Postgres and `1062` on MySQL. Both implementations normalise this to `{ duplicate: true }`, so the webhook's idempotency logic no longer contains a database-specific magic string.
- No `@>` containment operator in MySQL — the dispute kill-switch uses `JSON_UNQUOTE(JSON_EXTRACT(...))` there.
- No array type in MySQL, so `bounded_by` is JSON there and `text[]` in Postgres.
- MySQL `DATETIME` rejects an ISO string with a trailing `Z`, and returns `TINYINT(1)` where Postgres returns a boolean. Both are converted at the boundary so the pipeline only ever sees ISO strings and real booleans.

**A side benefit worth noting:** the guardrail tests got substantially better. They previously mimicked a PostgREST client — a chainable fake with `.select().eq().maybeSingle()` — which tested the mock as much as the rules. They now inject domain operations and describe behaviour ("the consent lookup fails") instead, and the same suite covers both backends because the guardrails cannot tell which one they are talking to.

**Also fixed in passing:** `lib/supabase.ts` is gone, and with it the last module that threw at import time.
