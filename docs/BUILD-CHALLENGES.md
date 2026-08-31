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
