# Demo script — 90 seconds

Written to be spoken. Timings are generous; if you run long, cut section 4
before you cut section 3.

**Before recording:** `npm run preflight` (expect all green), confirm the
dashboard shows 1,200 events and conformance reads 0 violations, and have
`/dashboard`, one trace page, and `/dashboard/policy` already open in tabs.

---

## 0:00–0:12 — The problem, in one sentence

> "About one in four Razorpay payments that fail are recoverable — the card
> had no balance at 2pm, it does at 6pm. The hard part isn't sending a nudge.
> It's sending it to the right person, at the right time, without messaging
> someone who asked you not to — and then proving you actually caused the
> money to come back."

*On screen: the dashboard, money river flowing.*

## 0:12–0:30 — What it does

> "This watches Razorpay's webhook stream. Every failed payment gets a
> deterministic root-cause classification, then four guardrails, then an
> economic gate — and only then does a model get asked anything. And it's
> only ever asked *which* of three pre-approved actions fits. Never whether
> to act."

*Point at the river: ₹46 lakh at risk, splitting into recovered, still open,
held back, and the holdout.*

## 0:30–0:48 — The ledger, then one trace

> "Every decision writes its reasoning in plain English."

*Read one rationale aloud. Then click it.*

> "And every one is clickable. This is that payment's whole path,
> reconstructed from the audit log — not narrated by the code that did the
> work. Notice the order: guardrails, then the agent. An event stopped at the
> guardrails visibly never reaches the model."

## 0:48–1:08 — The number that matters

*Scroll to Measured lift.*

> "This is the only number here that establishes causation. Ten percent of
> eligible events are deliberately left untreated, so we can compare against
> doing nothing. Treated recovers at 32%, the holdout at 18% — a fourteen
> point lift, and the confidence interval clears zero."

> "And when it doesn't clear zero, the panel says why — it reports the
> smallest effect this holdout could even detect. A null result from a small
> holdout and a null result from an agent that doesn't work look completely
> different, and they should."

## 1:08–1:22 — The thing nobody else built

*Scroll to Safety conformance.*

> "Five thousand checks, zero violations. This is a second implementation of
> the safety rules that shares no code with the guardrails — it re-derives
> them from what was recorded. It caught a real violation during development:
> a resumed webhook evaluated one customer's consent while recording the
> action against another. Every component reported success. Nothing else
> could have seen it."

## 1:22–1:30 — Close

> "Eleven model calls served nine hundred decisions, because at temperature
> zero four hundred failures are only a couple of dozen distinct situations.
> It runs on Postgres or MySQL. And the batch is synthetic — which the
> dashboard says on screen, because the whole point is separating what we
> measured from what we assumed."

---

## If a judge asks

**"Is any of this real?"**
The pipeline is. Every number comes from 1,200 events posted through the
actual webhook route with real HMAC signatures — same code path as production.
The *recoveries* are simulated from a stated assumption, which the amber banner
says. The measurement machinery is real; the customer behaviour is not.

**"Has it actually sent a WhatsApp message?"**
Yes — to a verified recipient, template approved by Meta, message id in the
audit trail. Batch runs stay in dry run because the seeded numbers are
plausible real Indian mobiles.

**"What happens if the model returns garbage?"**
Human escalation. A refusal, a truncated response, or anything outside the
three approved actions all become an escalation rather than an action. The
schema is the first defence, not the only one.

**"How do you know the guardrails actually held?"**
The conformance panel — and it's an independent re-derivation, not a
restatement. That's the difference between a test that asserts what the code
does and one that asserts what should be true.

**"Does it scale?"**
Eleven model calls for nine hundred decisions is the answer to cost. For
throughput, `audit_log` is append-only and event-shaped, so it reads off a CDC
stream rather than polling at volume — `docs/DESIGN-DECISIONS.md`.

**"What would you do next?"**
Two things. Widen beyond failed payments to checkout abandonment and mandate
retries, which the classifier already has room for. And move the propensity
estimate from a Beta-binomial prior to a trained model once there's real
outcome data — the expected-value gate is already structured for it.

---

## What NOT to say

- Don't call the lift "proof the agent works". It's proof the *measurement*
  works on a synthetic batch. The distinction is the project's credibility.
- Don't hide the exceptions list. Scroll past it slowly if anything — an
  honest failure column is more convincing than a perfect dashboard.
- Don't claim real customers were messaged. One verified test recipient was.
