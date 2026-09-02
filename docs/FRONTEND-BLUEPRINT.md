# Frontend Blueprint — "The Recovery Desk"

A-to-Z spec for the UI. Written to be handed to a design tool (Google Stitch)
and then wired back to the live APIs.

Read Part 6 first if you just want prompts to paste. Everything before it is
the reasoning that makes the prompts produce the right thing.

---

## Part 0 — What this screen has to prove

A judge gives this maybe ninety seconds. In that time the screen has to land
four claims, in this order:

1. **This is real money, moving now.** Not a mock. Live ledger, live rupees.
2. **The agent reasons — and you can read the reasoning.** Rationale in plain
   English, per event, on screen.
3. **It is bounded.** It refuses to act, visibly, and says why.
4. **The lift is measured, not claimed.** A holdout arm exists, and the number
   has a confidence interval on it.

Every widget below exists to serve one of those four. If a widget serves none
of them, it is decoration and should be cut — density is a design choice here,
not a constraint.

**The design thesis:** a trading terminal that happens to be about failed
payments. Dark, dense, monospaced where it counts, one hero animation, and an
almost aggressive honesty about what the system did *not* do. Most hackathon
dashboards look like a marketing page. This should look like something that
runs in a payments ops room at 2am.

---

## Part 1 — Design system

### 1.1 Colour

Dark-first. The base is Razorpay Blade's dark scheme; these are the literal
values so Stitch can reproduce them without the library.

| Token | Hex | Use |
|---|---|---|
| `bg/base` | `#0B0D10` | Page background |
| `bg/raised` | `#14171C` | Card surface |
| `bg/sunken` | `#08090B` | Feed well, code blocks |
| `border/subtle` | `#1F242B` | Card hairline, dividers |
| `border/strong` | `#2C333C` | Focused / hovered card |
| `text/primary` | `#E8EDF4` | Headings, values |
| `text/secondary` | `#9BA6B4` | Labels, captions |
| `text/muted` | `#65707E` | Timestamps, ids |
| `accent/blue` | `#3395FF` | Razorpay blue — brand, links, agent actions |
| `accent/blue-dim` | `#12283F` | Blue chip fill |
| `positive` | `#12B981` | Recovered, invariant passed |
| `positive-dim` | `#0C2E23` | Positive chip fill |
| `warning` | `#F5A524` | Held back, degraded, synthetic notice |
| `warning-dim` | `#33260A` | Warning chip fill |
| `negative` | `#F04438` | Violation, delivery failed |
| `negative-dim` | `#3A1512` | Negative chip fill |
| `neutral` | `#5A6472` | Reused / cached, control arm |

**Rule: colour never carries meaning alone.** Every coloured chip also has a
word in it. A judge on a projector with washed-out contrast still has to be
able to read the state.

**Gradient (used exactly twice — hero and the money river):**
`linear-gradient(135deg, #3395FF 0%, #12B981 100%)`. Nowhere else. A gradient
used everywhere reads as a template; used twice it reads as a signature.

### 1.2 Typography

Two families, sharply divided by role.

- **Body / UI:** Inter (Blade's stack). 400 and 500 only.
- **Ledger:** JetBrains Mono, 400/500, with `font-feature-settings: "tnum"`.

Mono is used **only** for: numbers that are quantities, timestamps, event ids,
invariant ids (I1–I7), and section headings set in caps. Body copy and
rationales stay in Inter. Letting mono spread everywhere turns a ledger into a
generic hacker aesthetic and costs the design its point of view.

| Role | Size / line-height | Weight | Family |
|---|---|---|---|
| Hero number | 56 / 60 | 500 | Mono |
| Section heading (caps, `letter-spacing: 0.08em`) | 12 / 16 | 500 | Mono |
| Card stat value | 28 / 34 | 500 | Mono |
| Card stat label | 12 / 16 | 400 | Inter |
| Body / rationale | 14 / 21 | 400 | Inter |
| Caption / timestamp | 12 / 16 | 400 | Mono |

### 1.3 Spacing, radius, elevation

- 4px base scale: 4, 8, 12, 16, 24, 32, 48, 64.
- Radius: 12px cards, 8px chips, 6px inputs, 999px pills.
- **No drop shadows.** Elevation is expressed with `border/subtle` +
  `bg/raised` against `bg/base`. Shadows on a dark UI read as smudge.
- Card padding: 20px. Card gap: 16px.

### 1.4 Motion

Three motions, each with a job. Nothing else moves.

1. **Count-up** — every number tweens from 0 on first arrival. 600ms,
   `cubic-bezier(0.16, 1, 0.3, 1)`.
2. **Ledger insert** — a new feed row slides in from -6px with a 260ms fade,
   and its left rail flashes to full colour then settles over 800ms.
3. **River flow** — the hero's particles move continuously, 20s linear loop.

Everything respects `prefers-reduced-motion: reduce` — but the *state change*
still lands instantly. Reduced motion means no tween, not no update.

### 1.5 Accessibility floor

- Contrast at least 4.5:1 for all text. `text/muted` on `bg/raised` is the
  tightest pair; verify it.
- Every chart has a text equivalent adjacent to it. Numbers are always
  printed, never only encoded in a shape.
- Feed region is `aria-live="polite"`, not `assertive` — it updates constantly
  and assertive would make a screen reader unusable.
- Focus ring: 2px `accent/blue`, 2px offset, on every interactive element.

---

## Part 2 — Information architecture

Three routes. The first is 95% of the demo.

| Route | Name | Purpose |
|---|---|---|
| `/dashboard` | The Desk | Live operations view. The default. |
| `/dashboard/event/[id]` | Trace | One event's full decision path. Opened by clicking a feed row. |
| `/dashboard/policy` | Policy Lab | Counterfactual replay — what a different policy would have done. |

---

## Part 3 — Layout

Desktop-first (this is judged on a laptop or projector), 1440px design width.

```
+--------------------------------------------------------------+
|  HEADER            brand . env pill . live pill               |  72px
+--------------------------------------------------------------+
|  HERO - THE MONEY RIVER                                       |  320px
|  (full bleed, gradient, animated Sankey)                      |
+--------------------------------------------------------------+
|  STAT STRIP  [at risk] [recovered] [rate] [avg time]          |  108px
+-------------------------------+------------------------------+
|                               |  MEASURED LIFT               |
|  LIVE REASONING LEDGER        +------------------------------+
|  (the anchor - tallest        |  CONFORMANCE SHIELD          |
|   element on the page,        +------------------------------+
|   internally scrolled)        |  COST OF SAFETY              |
|                               +------------------------------+
|                               |  BY ROOT CAUSE               |
+-------------------------------+------------------------------+
|  DECISION CACHE CONSTELLATION | EXCEPTIONS / DECLINED        |
+--------------------------------------------------------------+
```

Grid: 12 columns, 24px gutter, 32px page margin.
Main column spans 7, rail spans 5. Below 1100px it collapses to one column
with the ledger first. Below 720px the river degrades to a static stacked bar
(see 4.1).

---

## Part 4 — Widget catalogue

Every widget lists its exact data binding against the live APIs, so whatever
Stitch produces can be wired without guessing.

APIs available now:
- `GET /api/batch-summary` — totals, root causes, experiment arms, exceptions
- `GET /api/audit-feed` — last 60 `agent_decided` + `action_executed` rows
- `GET /api/conformance` — 7 invariants + compliance cost

---

### 4.1 THE MONEY RIVER  *(hero — build this one properly)*

**Purpose.** Claim 1 and claim 3 at once: shows the whole batch's rupees as a
single flowing quantity, and shows it splitting into what was recovered, what
was deliberately not chased, and what was lost.

**Visual.** A horizontal Sankey, full width, 320px tall, on `bg/sunken` with
the signature gradient used for the flowing strands.

```
                            +--> RECOVERED      Rs 1,63,701  (green)
  Rs AT RISK --+- AGENT ACTED
   Rs 8,42,300 |              +--> STILL OPEN    Rs 2,11,400  (dim blue)
               |
               +- HELD BACK -----> GUARDRAIL     Rs 58,200    (amber)
               +- NOT WORTH IT --> EV NEGATIVE   Rs 12,900    (neutral)
               +- HOLDOUT -------> MEASURING     Rs 41,100    (neutral)
```

- Strand thickness is proportional to rupees, not event count. Money is the
  unit the audience cares about.
- **Particles**: 2px dots travelling each strand, density proportional to
  event count. This is what makes it read as *live* rather than as a chart.
  20s linear loop, `will-change: transform`, capped at 120 particles total so
  it never costs frames on a projector.
- Each terminal node has its rupee value in mono, 20px, and its label in
  Inter caps 11px.
- Hovering a strand dims the others to 25% and shows a tooltip with the event
  count and a one-line description.

**Data binding.**
- At risk: `total_at_risk_paise`
- Recovered: `recovered_paise`
- Held back: `exceptions[]` where reason starts `guardrail_check_failed` or is
  `customer_dnd_opt_out` / `max_retry_attempts_reached` /
  `cooldown_window_active` / `refund_or_dispute_flagged`
- EV negative: `exceptions[]` where reason is `negative_expected_value`
- Holdout: `experiment.control.n` (needs a rupee sum — Part 7, item 1)

**States.**
- *Loading:* strands drawn at 30% opacity, no particles, values show `—`.
- *Empty (0 events):* river collapses to a flat line with the copy
  "No revenue-at-risk events yet. Send a test payment failure to begin."
- *Offline:* last good river stays, desaturated to 60%, with an amber pill.
- *Mobile (<720px):* becomes a single vertical stacked bar with the same
  colour coding and labels. Do not try to shrink the Sankey.

---

### 4.2 STAT STRIP

Four cards, equal width. Each: label (12px Inter secondary), value (28px mono
primary), sub-caption (11px mono muted).

| Card | Value | Sub-caption |
|---|---|---|
| Total at risk | `rupees(total_at_risk_paise)` | `{total_events} failed payments` |
| Recovered | `rupees(recovered_paise)` | green value |
| Recovery rate | `recovery_rate * 100` -> `37.6%` | `{recovery_rate_attempted}% of {attempted_events} attempted` |
| Avg. time to recovery | `avg_time_to_recovery_minutes` -> `18 min` | `across {timed_recoveries} recoveries` |

All four count up on arrival. Null renders as `—`, never `0` — the difference
between "we don't know yet" and "nothing was recovered" is the most important
distinction on this page.

---

### 4.3 LIVE REASONING LEDGER  *(the anchor)*

**Purpose.** Claim 2. This is the widget the demo is actually judged on.

**Visual.** A scrolled well (`bg/sunken`, inset border, max-height 620px) of
rows. Each row:

```
|# +-----------------------------------------------------------+
|# | . Sent WhatsApp retry      [reused]              14:22:07  |
|# | Insufficient funds . Rs 2,340                              |
|# | Card was declined for insufficient balance; a WhatsApp      |
|# | nudge in a few hours has the best chance of catching the    |
|# | customer after payday.                                      |
|# | plink_QxR2m9                                                |
|# +-----------------------------------------------------------+
```

- **Left rail**: 3px vertical bar, full row height, coloured by outcome —
  blue (decided), green (executed), red (delivery failed), neutral (reused).
  This is what lets a judge scan 25 rows in two seconds.
- Action label as a chip. Timestamp mono, right-aligned.
- Root cause + amount on one muted line.
- **The rationale gets body treatment (14px Inter, primary text)** — it is the
  explainability artifact and the reason the panel exists. Do not shrink it to
  a caption.
- A `reused` chip in neutral when `detail.from_cache === true`. Never hide
  this: the rationale is identical because the situation is identical, and
  implying fresh reasoning would be a lie.
- Payment link id in mono muted, linking to the Razorpay dashboard.
- Whole row is clickable, opening the Trace view (4.8).

**Data binding.** `/api/audit-feed` -> `feed[]`, take 25.
`row.stage`, `row.detail.action` / `row.detail.channel`, `row.detail.rationale`,
`row.detail.from_cache`, `row.detail.payment_link_id`,
`row.detail.delivery_success`, `row.event.root_cause`, `row.event.amount_paise`,
`row.created_at`.

**States.** Empty: "No revenue-at-risk events yet — send a test payment
failure to see the agent respond." Offline: rows stay, header shows amber
"Feed unavailable — showing last known state".

**Motion.** New rows insert at top with the ledger-insert animation. Rows are
keyed by audit id so existing rows never re-animate on poll.

---

### 4.4 MEASURED LIFT

**Purpose.** Claim 4. The only causal number on the page.

**Visual.** Two vertical bars side by side, 120px tall, plus a floating
confidence interval bracket.

```
  MEASURED LIFT vs HOLDOUT               [ Significant ]

   37.6%          17.2%           +-----+-----+
   ####           ###             |  +20.3 pp |
   ####           ###             +- 5.5 - 35.2 -+
   ####
   TREATED        CONTROL           Rs 1,63,701 incremental
   103 / 274      5 / 29
```

- Treated bar: gradient fill. Control bar: flat `neutral`.
- The CI bracket is drawn as an actual whisker, not text — a visible interval
  is what communicates "we know how sure we are".
- Badge: green `Significant` or neutral `Not yet conclusive`, bound to
  `lift.significant`.
- Caption underneath, always: "Recovery the agent caused, over what these
  events would have returned untouched."

**Data binding.** `experiment.treated`, `experiment.control`, `experiment.lift`
(`treatedRate`, `controlRate`, `absoluteLiftPp`, `ci95Pp`, `incrementalPaise`,
`significant`, `caveat`).

**State — no control arm yet:** "No holdout data yet — {holdout_percent}% of
eligible events are withheld to measure the do-nothing baseline."

---

### 4.5 CONFORMANCE SHIELD

**Purpose.** Claim 3, mechanically. This is the most differentiated thing in
the project and the UI should treat it that way.

**Visual.** Seven tiles in a 4+3 grid. Each tile: invariant id in mono
(`I1`…`I7`), a one-line description, and a state.

- Passing tile: `positive-dim` fill, 1px `positive` border, a small check, and
  the check count in mono (`274 ok`).
- Failing tile: `negative-dim` fill, `negative` border, pulsing at 2s, and the
  violation count. Clicking expands the violation details inline.
- Header carries a single badge: `All invariants held · 1,284 checks` (green)
  or `38 violation(s)` (red).

**The line that has to be on this panel, in secondary text:**

> "Re-derived from the recorded data by a verifier that shares no code with
> the guardrails that enforce it."

That sentence is the entire argument for the panel. Without it a judge reads
seven green boxes as decoration.

**Data binding.** `/api/conformance` -> `conformance.results[]`
(`id`, `description`, `checked`, `violations[]`), plus `conformance.passed`,
`totalChecked`, `totalViolations`.

---

### 4.6 COST OF SAFETY

**Purpose.** Credibility. Safety isn't free and saying so out loud is worth
more than implying it is.

**Visual.** Styled as a receipt — right-aligned mono figures, a hairline rule
above the total, total in 24px mono.

```
  WHAT THE RULES COST                     (estimated)

  Compliance rules              12 .   Rs 28,400
  Holdout (price of knowing)    29 .   Rs 41,100
  Not worth chasing              8 .   Rs 12,900
  Safety check unavailable       1 .    Rs 3,200
  ---------------------------------------------
                                       Rs 85,600
  Recovery foregone to keep the rules - estimated, not measured.
```

**Data binding.** `complianceCost.byCategory` (filter `count > 0`),
`complianceCost.totalForegonePaise`.

---

### 4.7 BY ROOT CAUSE

Horizontal bars, sorted by rupees descending. Bar fill `accent/blue-dim` with
a 2px `accent/blue` leading edge. Label left, `{count} · Rs {amount}` right in
mono.

**Data binding.** `by_root_cause` — an object keyed by cause. Labels come from
a lookup with a humanising fallback, so a new root cause added later still
renders correctly without a UI change.

---

### 4.8 DECISION TRACE  *(new — route `/dashboard/event/[id]`)*

**Purpose.** The "click anything and see exactly what happened" moment. This
is the widget that converts scepticism.

**Visual.** A horizontal waterfall of the pipeline stages, left to right, each
a node with a timestamp and a state:

```
 RECEIVED -> CLASSIFIED -> GUARDRAILS -> EV GATE -> ARM -> DECIDED -> EXECUTED -> OUTCOME
  14:22:01    14:22:01      14:22:01     14:22:01  14:22:01 14:22:04   14:22:05    14:47:12
    ok          ok            ok           ok        ok       ok         ok       RECOVERED
```

- A stopped event shows the stage where it halted in amber/red, and every
  stage after it greyed with a dashed connector — you can see at a glance
  *where* it stopped.
- Below the waterfall: the full rationale, the payload that was classified,
  the guardrail results one by one, and the model name that answered.
- This is where the raw JSON lives, in a collapsed `<details>`.

**Data binding.** Needs one new endpoint — Part 7, item 2.

---

### 4.9 DECISION CACHE CONSTELLATION  *(new)*

**Purpose.** Shows off the memoisation result, which is genuinely unusual:
**32 model calls served 262 decisions.**

**Visual.** A scatter of circles on `bg/sunken`. One circle per distinct
decision situation (cache key). Circle area proportional to events served by
that key. Fresh calls in `accent/blue`, reused in `neutral`. A single headline
above it:

```
  32 model calls  ->  262 decisions        88% reused
```

Hovering a circle shows the cache key decoded in plain English:
`insufficient_funds . card . Rs 2,000-10,000 . 1st attempt . nothing tried yet`

**Why it belongs on the page:** it is the answer to "does this scale?", and it
answers it with a measurement rather than an assertion.

**Data binding.** Needs one new endpoint — Part 7, item 3.

---

### 4.10 EXCEPTIONS — two lists, deliberately separate

**"Could not resolve"** (red chips) and **"Declined on purpose"** (blue chips).

The split is a design argument, not a detail: a holdout control and a
negative-EV skip are the agent exercising judgment. Filing them under failures
would misrepresent the system's best behaviour as its worst.

**Data binding.** `exceptions[]`, partitioned on whether `reason` is in
`{holdout_control, negative_expected_value}`.

---

### 4.11 SYNTHETIC BATCH NOTICE

An amber-bordered strip directly under the hero whenever
`synthetic_events > 0`:

> **Synthetic batch** — {n} of {total} events are seeded. Recoveries are
> simulated from a stated assumption, so the lift below demonstrates the
> measurement working; it is not evidence about real customers.

Do not let anyone talk you into removing this. The project's entire thesis is
separating measured from estimated, and a dashboard that hides its own
provenance forfeits that argument at the first hard question.

---

### 4.12 POLICY LAB  *(new — route `/dashboard/policy`)*

**Purpose.** The "beyond the horizon" widget. Three sliders — holdout %, EV
threshold, cooldown hours — and a **Replay** button. It re-runs the recorded
batch against the new policy using cached decisions (so it costs no model
calls) and shows a before/after diff:

```
  POLICY v1  ->  POLICY v2 (simulated)

  Events acted on      274  ->  312    +38
  Blocked by cooldown   35  ->   11    -24
  Incremental recovery  Rs 1,63,701 -> Rs 1,88,400   +Rs 24,699
  Conformance           7/7 held  ->  7/7 held
```

Everything is labelled **simulated**, and the panel says which parts are
counterfactual estimates rather than measurements.

**Data binding.** Needs a replay endpoint — Part 7, item 4. This is the
biggest new build; ship 4.1–4.11 first.

---

## Part 5 — Copy deck

Exact strings. Tone: precise, unhedged, never salesy. No exclamation marks
anywhere.

| Element | String |
|---|---|
| Page title | Revenue Recovery — Live |
| Subtitle | Root-cause reasoning, bounded actions, and a full audit trail over Razorpay's failed-payment stream. |
| Live pill | Live / Connecting / Feed unavailable |
| Env pill | TEST MODE |
| Hero label | Revenue at risk, and where it went |
| Ledger heading | LIVE REASONING |
| Lift heading | MEASURED LIFT vs HOLDOUT |
| Conformance heading | SAFETY CONFORMANCE |
| Conformance subtitle | Re-derived from the recorded data by a verifier that shares no code with the guardrails that enforce it. |
| Cost heading | WHAT THE RULES COST |
| Cost footnote | Recovery foregone to keep the rules — estimated, not measured. |
| Root cause heading | BY ROOT CAUSE |
| Exceptions heading | EXCEPTIONS — COULD NOT RESOLVE |
| Declined heading | DECLINED ON PURPOSE |
| Cache heading | DECISION REUSE |
| Empty feed | No revenue-at-risk events yet — send a test payment failure to see the agent respond. |
| Offline | Feed unavailable — showing last known state. |

Action labels: `Sent WhatsApp retry`, `Sent email retry`, `Escalated to human`,
`Sent via WhatsApp`, `Sent via email`, `Queued for human review`.

Stopping reasons: `Customer opted out (DND)`, `Reached retry limit`,
`Reached cooldown window`, `Refunded or disputed`,
`Unrecognised failure — needs review`, `Agent response unusable — escalated`,
`Not worth chasing (cost exceeds expected recovery)`,
`No customer id — consent unverifiable`,
`Holdout control — deliberately untreated`, `Could not record experiment arm`,
`Safety check unavailable — held back`.

---

## Part 6 — Google Stitch prompts

Paste these one at a time. Each is self-contained; Stitch does better with a
single screen described densely than with a whole app described thinly.

### Prompt 1 — The Desk (main dashboard)

> Design a dark, dense operations dashboard for a payments AI agent that
> recovers failed transactions. It should feel like a professional trading
> terminal, not a marketing page.
>
> Background #0B0D10, cards #14171C with 1px #1F242B borders, 12px radius, no
> drop shadows. Body text Inter in #E8EDF4 and #9BA6B4; all numbers,
> timestamps and ids in JetBrains Mono with tabular figures. Accent blue
> #3395FF, positive green #12B981, warning amber #F5A524, negative red
> #F04438.
>
> Top: a 72px header with the title "Revenue Recovery — Live", a small "TEST
> MODE" pill, and a green pulsing-dot "Live" pill on the right.
>
> Below it, a full-width 320px hero: a horizontal Sankey flow diagram labelled
> "Revenue at risk, and where it went". One thick strand enters from the left
> labelled "₹8,42,300 AT RISK" and splits into five outcomes — "Recovered"
> (green), "Still open" (dim blue), "Held back by guardrail" (amber), "Not
> worth chasing" (grey), "Holdout — measuring" (grey). Strand thickness is
> proportional to the rupee amount. Strands use a blue-to-green gradient with
> small dots flowing along them. Each endpoint shows a rupee figure in
> monospace.
>
> Under the hero, an amber-bordered notice strip: "Synthetic batch — 400 of
> 409 events are seeded. Recoveries are simulated from a stated assumption."
>
> Then a row of four stat cards: "Total at risk ₹8,42,300", "Recovered
> ₹1,63,701" (green), "Recovery rate 37.6%" with sub-caption "37.6% of 274
> attempted", "Avg. time to recovery 18 min".
>
> Then a two-column layout, 7 columns left and 5 right with a 24px gutter.
>
> Left column, full height: a panel headed "LIVE REASONING" in 12px monospace
> caps with wide letter spacing, containing a scrolling list of event cards on
> a darker inset background. Each card has a 3px coloured left rail, a status
> chip ("Sent WhatsApp retry"), an optional grey "reused" chip, a
> right-aligned monospace timestamp, a muted line reading "Insufficient funds ·
> ₹2,340", and then two lines of plain-English explanation in normal-sized body
> text. Some cards show a monospace payment link id at the bottom.
>
> Right column, four stacked cards:
> 1. "MEASURED LIFT vs HOLDOUT" with a green "Significant" badge, two vertical
>    bars labelled "Treated 37.6% (103/274)" and "Control 17.2% (5/29)", a
>    confidence-interval bracket floating to the right reading "+20.3 pp, 5.5
>    to 35.2", and "₹1,63,701 incremental" in large green monospace.
> 2. "SAFETY CONFORMANCE" with a green badge "All invariants held · 1,284
>    checks" and a grid of seven small tiles labelled I1 to I7, each green with
>    a check mark and a count.
> 3. "WHAT THE RULES COST" styled like a receipt, four right-aligned rupee
>    line items, a hairline rule, and a bold total.
> 4. "BY ROOT CAUSE" with five horizontal bars.
>
> Bottom row: left, a panel headed "DECISION REUSE" showing "32 model calls →
> 262 decisions, 88% reused" above a scatter of circles of varying sizes in
> blue and grey. Right, two short lists — "EXCEPTIONS — COULD NOT RESOLVE"
> with red chips and "DECLINED ON PURPOSE" with blue chips.
>
> Use generous internal padding but tight vertical rhythm. Prioritise
> information density over whitespace.

### Prompt 2 — Decision Trace (event detail)

> Design a dark detail page showing one payment's full journey through an AI
> agent pipeline. Same palette as before: #0B0D10 background, #14171C cards,
> Inter body, JetBrains Mono numbers, blue #3395FF, green #12B981.
>
> Header: a back link, the event id in monospace, the amount "₹2,340" large,
> and a green "RECOVERED" badge.
>
> Main element: a horizontal waterfall of eight stages left to right —
> Received, Classified, Guardrails, EV Gate, Arm, Decided, Executed, Outcome.
> Each stage is a node with a monospace timestamp beneath it and a state icon,
> connected by thin lines. Completed stages are green; the current one is blue.
> Show a second example underneath where the flow stops at "Guardrails" in
> amber, with all following nodes greyed out and connected by dashed lines.
>
> Below: three cards side by side — "Classification" showing root cause and the
> raw error code, "Guardrails" listing four named checks each with a pass or
> block state, and "Decision" showing the chosen action, the model name in
> monospace, and a paragraph of plain-English rationale.
>
> At the bottom, a collapsed expandable row labelled "Raw webhook payload".

### Prompt 3 — Policy Lab

> Design a dark "what-if" simulator page. Same palette.
>
> Left third: a card headed "POLICY" with three labelled sliders — "Holdout
> 10%", "Minimum expected value ₹40", "Cooldown 24 h" — and a prominent blue
> "Replay batch" button beneath them.
>
> Right two-thirds: a before/after comparison card headed "POLICY v1 → POLICY
> v2 (simulated)". Four rows, each showing a metric name, the old value, an
> arrow, the new value, and a coloured delta chip: "Events acted on 274 → 312
> (+38)" green, "Blocked by cooldown 35 → 11 (-24)" green, "Incremental
> recovery ₹1,63,701 → ₹1,88,400 (+₹24,699)" green, "Conformance 7/7 held →
> 7/7 held" neutral.
>
> An amber note at the bottom: "Simulated by replaying recorded events against
> the new policy. Counterfactual estimate, not a measurement."

### Prompt 4 — Mobile

> Adapt the dashboard to a 390px-wide phone screen. Single column. The Sankey
> becomes a vertical stacked bar with the same five coloured segments and
> labels. Stat cards become a 2x2 grid. The live reasoning ledger comes
> immediately after the stats and is the tallest section. Lift, conformance,
> cost and root cause stack below it as full-width cards.

---

## Part 7 — What I need back, and what I still have to build

Hand me the Stitch output as **screenshots plus whatever HTML/CSS it exports**.
I will rebuild it against Blade components so it stays on Razorpay's own design
system — worth real credit with these judges — and keep the exported CSS only
for the custom visuals Blade has no equivalent for (the river, the
constellation, the waterfall).

Four backend gaps the new widgets need. In build order:

1. **Rupee sums per outcome bucket** for the river. `batch-summary` currently
   returns exception *reasons* but not the amounts behind them. Small change:
   join the exception list back to event amounts.
2. **`GET /api/event/[id]/trace`** — every audit row for one event, ordered,
   plus the decision, guardrail results and outcome. All the data already
   exists in `audit_log`; this is a read.
3. **`GET /api/cache-stats`** — distinct cache keys, events served per key,
   fresh vs reused counts. `countCachedDecisions()` exists; needs a group-by.
4. **`POST /api/replay`** — the Policy Lab. Replays recorded events through the
   guardrail and EV logic with an overridden policy, reusing cached decisions
   so it costs nothing. The largest of the four; treat it as optional if time
   is short.

---

## Part 8 — Things not to do

- **Don't make it light-themed.** The ledger metaphor collapses.
- **Don't remove the synthetic notice** or soften its wording.
- **Don't animate the numbers on every poll** — only on first arrival and on
  genuine change. Constantly-tweening figures read as unstable.
- **Don't put a "Recover all" button on it.** A big irreversible action invites
  a judge to ask what happens if it misfires, and the honest answer is that
  nothing in the design needs it.
- **Don't show a fake progress bar or a fake "agent thinking" spinner.** The
  reasoning either arrived or it didn't.
- **Don't round rupees to lakhs/crores.** Exact figures in tabular numerals are
  the whole aesthetic.
- **Don't let the conformance panel show green when the verifier hasn't run.**
  Absent is `—`, not passing.
