# The 5-minute pitch video

Written to be spoken aloud. Every number here is real and on the deployed
instance — nothing in this script requires a mock.

**Before you record**

- `npm run preflight` → all green
- Open four tabs: `/dashboard`, a trace page, `/dashboard/policy`, `/dashboard/redteam`
- Have `https://rzp.io/rzp/qrrrPp3u` ready, and your phone visible
- Screen-record at 1440px. The dashboard is built for it.

---

## 0:00 – 0:25 · Cold open: show the payoff first

**Do not start with a slide.** Start with your phone on screen, showing the
real WhatsApp the agent sent.

> "This message came from an AI agent. A real payment on Razorpay failed
> about a minute earlier — this thing noticed, worked out why, decided what
> to do about it, created a new payment link through Razorpay's own MCP
> server, and sent it. Nobody was involved."

Then cut to the dashboard.

> "And every one of those steps is on the record, which is the actual point."

*Why this open: the first fifteen seconds decide whether a judge leans in.
Leading with a real artifact on a real phone beats any architecture diagram.*

## 0:25 – 1:00 · The problem, stated properly

> "About a quarter of failed payments are recoverable. The card had no
> balance at 2pm and does at 6pm, the bank timed out, the gateway dropped.
> Sending a nudge is the easy part — you could do that with a cron job.
>
> The hard parts are: sending it to the right person, at a moment that helps,
> without messaging someone who asked you never to contact them. And then
> proving the money came back *because* you acted, rather than coincidentally
> after you did.
>
> Most recovery tools do the easy part and claim the hard parts."

## 1:00 – 1:50 · Do it live

Fail the payment on camera. Real card, real failure.

> "I'm failing a real payment right now."

Cut to the dashboard while it processes. Point at the ledger as the row lands.

> "Razorpay just fired a signed webhook at this. It verified the signature,
> classified the root cause — gateway error, recoverable — ran four
> guardrails, checked whether acting was even worth the cost, and only then
> asked a model anything."

Read the rationale aloud from the screen.

> "And it's only ever asked *which* of three pre-approved actions fits. Never
> whether to act. That distinction is the whole design."

*If the cooldown blocks it because you tested recently, do not cut that. Say:
"and there it's refusing, because this customer was contacted eighteen
minutes ago." A guardrail firing live is better footage than a clean run.*

## 1:50 – 2:40 · Click into one payment

> "Every row is clickable."

Open the trace.

> "This is that payment's entire path, rebuilt from the audit log — not
> narrated by the code that did the work. Received, classified, guardrails,
> decided, executed, outcome.
>
> Look at the order. **Guardrails run before the agent.** An event stopped
> there visibly never reaches the model — you can see the gap. That's not a
> diagram of intent, it's what actually happened to this payment."

## 2:40 – 3:20 · The only number that means anything

Scroll to Measured lift.

> "Everything above this line is attribution. This line is measurement.
>
> Ten percent of eligible events are deliberately left untreated, so there's
> a do-nothing baseline to compare against. Treated recovers at 33%, the
> holdout at 12%. Twenty-one points of lift, confidence interval clears zero."

Then — and this is the bit almost nobody does:

> "And when it *doesn't* clear zero, this panel says why. It reports the
> smallest effect this holdout could even have detected. 'Not significant'
> because the agent didn't work and 'not significant' because thirty control
> events can't resolve a fifteen-point difference are completely different
> statements, and a dashboard that shows them identically is lying to you."

## 3:20 – 4:20 · Attack it on camera

Open `/dashboard/redteam`. Hit run. Let it play.

> "Every safety rule in here is invisible when it works. A fail-closed
> guardrail looks exactly like no guardrail until something attacks it. So
> here's me attacking my own system."

Let the rows land. Call out three:

> "Forged signature — rejected. Database taken down mid-check, so the
> guardrails can't be evaluated — it refuses rather than proceeds. And this
> one: an empty webhook secret.
>
> That was a real bug in this codebase. `createHmac` with an empty key
> doesn't throw — it computes a perfectly valid HMAC with a key everyone
> knows. My `.env` file ships that variable blank, so an unconfigured deploy
> accepted forged webhooks and looked rigorous doing it.
>
> Today, in production, that fix refused six real Razorpay deliveries while
> the secret was missing. It's not a hypothetical, it's load-bearing."

## 4:20 – 5:00 · What real data taught me, and close

> "Two things I only learned by pointing this at real traffic.
>
> First — my classifier was reading Razorpay's error *description*, the
> sentence written for a human, and ignoring `error_reason` and
> `error_source`, the structured fields that actually name the cause. It
> worked perfectly on my synthetic batch, because I'd written both the
> fixtures and the parser. Real payments classified as 'unknown' and went to
> human review. The fixtures and the code were wrong in the same direction.
>
> Second — I was recording WhatsApp messages as *delivered* when Meta had
> only *accepted* them. Three messages, all logged as successes, none
> arrived. On a project whose entire argument is an honest audit trail,
> that's the worst kind of bug, and real data is the only thing that finds
> it."

Close:

> "Eleven model calls served nine hundred decisions, because at temperature
> zero a thousand failures are only a few dozen distinct situations. It runs
> on Postgres or MySQL. Two hundred and fifty tests.
>
> And the batch behind these numbers is synthetic — which the dashboard says
> on screen, in amber, permanently. The measurement machinery is real. The
> customer behaviour isn't. Being clear about which is which is the entire
> reason to trust anything else on this screen."

---

## Delivery notes

**Pace.** Five minutes is long. The first minute is the only one you can
assume gets full attention — spend it on the phone, the live failure, and the
ledger. Never spend it on architecture.

**Do not read the architecture aloud.** Judges can read the README. Show
things happening.

**Volunteer the caveat.** Say "this batch is synthetic" before anyone asks.
Volunteered, it reads as rigour. Extracted, it reads as spin. This is the
single biggest difference between a video that wins and one that gets picked
apart in Q&A.

**Let a guardrail block something.** A refusal on camera is worth more than
three successes. It's the only way to show the safety machinery is real.

## The three sentences to land

If a judge remembers nothing else:

1. **"Guardrails run before the model, and the model is only ever asked which of three approved actions fits — never whether to act."**
2. **"A separate verifier re-derives the safety rules from the audit trail and shares no code with the guardrails that enforce them. It caught a real consent violation that every other signal reported as success."**
3. **"The holdout tells us the money came back because we acted, and the panel says how small an effect it could have detected — so a null result can't be mistaken for a failure."**

## Likely questions

**"Is any of this real?"**
The pipeline is entirely real. Six genuine Razorpay events went through the
deployed instance today, produced three real payment links through the MCP
server, and one WhatsApp that arrived. The 1,200-event batch is synthetic and
labelled as such — recoveries there are simulated from a stated assumption.

**"What happens if the model returns garbage?"**
Human escalation. A refusal, a truncated response, or anything outside the
three approved actions all become escalations rather than actions. The JSON
schema is the first defence, not the only one.

**"How do you know the guardrails held?"**
The conformance panel — 5,300 checks, zero violations. And it's an
independent re-derivation, not a restatement of what the guardrails intended.

**"Does it scale?"**
Eleven model calls for nine hundred decisions answers cost. For throughput,
`audit_log` is append-only and event-shaped, so at volume the dashboard reads
a CDC stream rather than polling.

**"What's broken?"**
Two things, and I'd rather say them than be caught by them. Concurrent
webhook redeliveries once produced two payment links for one event — fixed
with a database constraint, since no amount of application-level checking
closes that window. And there's an intermittent test failure I've seen twice
and cannot yet reproduce.

**"What's next?"**
Widen past failed payments to checkout abandonment and mandate retries — the
classifier already has room. And replace the Beta-binomial propensity prior
with a trained model once there's real outcome data; the expected-value gate
is already shaped for it.
