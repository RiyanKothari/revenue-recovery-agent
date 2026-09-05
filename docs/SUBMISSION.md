# Buildathon submission — answers to paste

---

## Project Name / Title

**Revenue Recovery Desk — an auditable agent for failed-payment recovery**

*(Shorter alternative if the field is tight: **Revenue Recovery Desk**)*

---

## Project Objectives — What does it solve?

Roughly a quarter of failed Razorpay payments are recoverable: the card had no
balance at 2pm and does at 6pm, the bank timed out, the network dropped
mid-authorisation. Sending a nudge is the easy part. The hard parts are
sending it to the *right* person at the *right* time without contacting
someone who asked not to be — and then proving the money came back *because*
you acted, rather than coincidentally after you did.

This is a bounded agent that sits on Razorpay's webhook stream and does three
things most recovery bots skip:

**1. It is gated in code, not in a prompt.** Every failed payment is
classified deterministically, then passed through four guardrails (consent,
retry ceiling, cooldown, refund/dispute kill-switch) and an expected-value
gate. Only then is a model asked anything — and it is only ever asked *which*
of three pre-approved actions fits, never *whether* to act. Every safety check
fails closed: if a rule cannot be evaluated, the action is refused. Executing
the recovery goes through Razorpay's own MCP server and the WhatsApp Cloud
API.

**2. It proves the money came back because of it.** Ten percent of otherwise
eligible events are deliberately left untreated as a holdout, so recovery is
*measured* against a do-nothing baseline rather than attributed to whatever
happened after a message. On the deployed instance the treated arm recovers
at 33.1% against the holdout's 12.1% — a **+21.0pp lift, 95% CI [14.1, 27.9],
₹7,56,982 incremental**. The dashboard also reports the smallest effect the
holdout could have detected, so an inconclusive result reads as "this
experiment was too small to tell" rather than "the agent didn't work".

**3. It can prove the safety rules actually held.** A conformance verifier
re-derives seven invariants from the recorded audit trail using code that
shares nothing with the guardrails that enforce them — **5,346 checks, zero
violations**. This is the piece that earns its keep: during development it
caught a real consent violation that every other signal reported as success.
A companion Red Team screen attacks the live system with ten hostile inputs
and shows each being refused, because a fail-closed guardrail looks exactly
like no guardrail until something attacks it.

**And it has done all of this on real Razorpay traffic.** Six genuine
payment.failed events reached the deployed instance today, producing three
real payment links through Razorpay's MCP server and a WhatsApp that arrived
on a phone. Three guardrails refused real events along the way: signature
verification rejected six deliveries while a secret was unset, and the
cooldown blocked a second nudge to a customer contacted eighteen minutes
earlier.

The system is honest about its own limits on screen. The demo batch is
synthetic, and the dashboard says so in an amber banner, because the entire
thesis is separating what was measured from what was assumed — and a
dashboard that hides its own provenance forfeits that at the first hard
question.

---

## GitHub Repository URL

```
https://github.com/RiyanKothari/revenue-recovery-agent
```

> **Before submitting: flip the repo to Public.** Settings → General → Danger
> Zone → Change visibility. It is currently private and judges will get a 404.

**Live deployment:** https://revenue-recovery-agent-plum.vercel.app/dashboard

---

## 5-min Pitch Video Link

*(Yours to record — the beat-by-beat script is in `docs/DEMO-SCRIPT.md`.)*

Suggested five-minute structure, extending the 90-second version:

| Time | Beat |
|---|---|
| 0:00–0:25 | Cold open on the phone: the real WhatsApp the agent sent |
| 0:25–1:00 | The problem, and why "send a nudge" is the easy part |
| 1:00–1:50 | Fail a real payment live; watch it land in the ledger |
| 1:50–2:40 | Click into the trace — guardrails run *before* the model, visibly |
| 2:40–3:20 | Measured lift, the interval, and the statistical-power line |
| 3:20–4:20 | Red Team: attack the live system on camera |
| 4:20–5:00 | What real data taught, and the synthetic caveat said out loud |

---

## Build Challenges & Technical Obstacles

Ten that changed the system. All are documented in full in
`docs/BUILD-CHALLENGES.md` (~20 entries).

**1. The webhook signature check had an authentication bypass.**
`crypto.createHmac("sha256", "")` does not throw — it computes a perfectly
valid HMAC with an empty key. So with `RAZORPAY_WEBHOOK_SECRET` unset or
blank, every verification still ran, still looked rigorous, and passed for
anyone able to compute an HMAC with a key that is public knowledge. The
`.env.local` template ships that variable blank, so "unconfigured" was the
default state of a fresh clone, and an attacker could have posted fabricated
payment failures and had the agent create real payment links. Fixed by
refusing a missing or empty secret at the point of use rather than trusting
deployment discipline, with tests that forge the empty-key signature and
assert refusal.

**2. The conformance verifier caught a consent violation nothing else could.**
A resumed webhook delivery trusted the incoming payload instead of the stored
event. Both carried the same event id but different bodies, so the guardrails
evaluated one customer's consent while the action was recorded against
another — who had DND set. Every component behaved correctly, the pipeline
reported success, and the dashboard looked healthy. Only an independent
re-derivation of the safety properties could see it. That is the argument for
building the verifier, demonstrated rather than asserted.

**3. The cooldown was asking about the wrong four hours.**
It measured backwards from `Date.now()` rather than from when the payment
failed. Razorpay retries webhook deliveries with backoff, so a delayed event
was asked "was this customer contacted in the four hours before *this
moment*" when the question is about the four hours before the *failure*.
Under a delayed delivery the two windows do not overlap at all — the
guardrail holds perfectly while examining the wrong period. Surfaced only
because a counterfactual replay tool made the cooldown slider move nothing,
which led to discovering the synthetic batch compressed a week of failures
into ninety seconds and the guardrail had never been genuinely exercised.

**4. Configuration failures were being recorded as customer outcomes.**
Three separate times. An expired WhatsApp token returned OAuthException 190
on every send; Razorpay test mode capped payment links at 30 (a hard account
limit, not a rate limit) and every attempt past it failed; and a Meta proxy
502 returned HTML into an unguarded `JSON.parse`. Each filled the dashboard
with hundreds of "delivery failed" rows implying people had not received a
message that was never sent. Every one of those paths now names the culprit —
our credential, our quota, our traffic shape — and only genuine
undeliverables are recorded against a recipient. Over-quota links are marked
`simulated` on screen rather than failing.

**5. Serving a 400-event batch inside a 20-request/day model quota.**
At temperature 0 the answer to a given situation is identical, and 1,200
failures contain only about 57 genuinely distinct decision situations
(root cause × method × amount band × prior attempts). Decisions are memoised
on that situation. The property that keeps it honest: the cache key and the
prompt are derived from the same function, and the prompt carries an amount
*band* rather than the exact figure, so two events sharing a key are
genuinely indistinguishable and a cached rationale is true of either. Reuse
is labelled in the audit trail and on screen, never implied away. Result: 11
model calls served 908 decisions. Failures are deliberately never cached —
memoising an escalation caused by a truncated response would make one blip
permanent for that whole situation.

**6. The demo was reproducible only by accident, and then not at all.**
The generator was documented as deterministic "so a re-run produces the same
batch and the same measured numbers", and three `Math.random()` calls meant
it wasn't. Two runs of identical code produced different measured lift, and
on one the confidence interval crossed zero and the dashboard reported the
effect as unestablished on the strength of a different draw. Seeded
everything — keyed on the *order* id rather than the row id, because
`event.id` is a database-generated UUID that would have looked deterministic
while reproducing nothing. The reproducible result then exposed the real
problem: a 10% holdout of 400 events yields ~33 control observations, and 33
observations cannot resolve a 15-point difference. The experiment was
underpowered before it ran. The fix was more volume at the honest holdout
rather than inflating the holdout to make the demo look better.

**7. Real payloads exposed a classifier written against my own fixtures.**
The synthetic generator emitted an error code and a prose description, so
every classifier rule was a pattern tuned against sentences I had written
myself. A genuine Razorpay failure arrives with `error_description: "Payment
failed"` — carrying nothing — and the actual cause two keys away in
`error_reason` and `error_source`, which nothing was reading. Real events
classified as `unknown` and went to human review: correct behaviour on the
information available, and the wrong information to have been looking at.
The fixtures and the parser were wrong in the same direction, which is the
failure mode synthetic testing cannot detect by construction.

**8. Concurrent redeliveries produced two payment links for one event.**
Razorpay delivered the same webhook twice at once. The idempotency check is a
read followed by a write, both requests interleaved between them, and one
customer received two links four seconds apart — the precise harm the
guardrails exist to prevent. Neither caught it: the retry ceiling counts
actions and both read zero before either wrote, and the cooldown looks for
contact in a window ending at the event's own timestamp, which correctly
excludes sends landing after it. No application-level care closes that
window; a unique constraint does. The contract test fires three inserts
concurrently, because the sequential version passes without the constraint.

**9. Delivery was recorded as success when Meta had only accepted.**
Meta returns 200 with a message id for any recipient and silently drops those
not on a test number's allowed list. Three messages were logged as delivered
and none arrived. On a project whose entire argument is an honest audit
trail, asserting delivery it could not evidence — with no message id stored
to trace the claim — was the worst available category of bug. It now records
Meta's own word, `accepted`, alongside the id.

**10. A flaky test that was actually a defect in the fixture.**
An intermittent failure I had seen twice, never reproduced, and had been
reporting as unexplained. Running the suite in a loop caught it: the synthetic
batch generator defaulted `now` to `Date.now()` *inside* the per-event
timestamp function rather than taking it once per batch, so any run that
straddled a second boundary stamped its events from two different clocks. The
symptom was a determinism test comparing two generated batches and failing
about one run in three. The defect was worse than the symptom — a batch
stamped from many clocks is not the reproducible fixture the documentation
promised, and the cooldown gaps derived from those timestamps were off by a
second in a way nothing would have surfaced. Fixed by making the generator a
pure function of `(size, now)`; the test now asserts byte-identity at a fixed
instant and, separately, that a later run shifts only the timestamps. Eight
consecutive clean full runs since.

**Also worth noting:** the MySQL implementation compiled for weeks without a
single query ever executing — a strange kind of "dual database support" to
advertise. Both drivers now run the same 20-case contract sequence and are
asserted to agree; it immediately found a query ordering by a column that
does not exist.

---

## Quick facts, if a field asks

| | |
|---|---|
| Stack | Next.js 14, TypeScript, Razorpay Blade, PostgreSQL + MySQL |
| Agent | Gemini via a provider-agnostic adapter (Anthropic supported) |
| Execution | Razorpay MCP server (42 tools), WhatsApp Cloud API |
| Tests | 311, including a 30-case dual-driver database contract suite, in CI |
| Conformance | 7 invariants, 5,346 checks, 0 violations |
| Red Team | 10 hostile inputs against the live defences, all refused |
| Real traffic | 6 genuine Razorpay events, 3 real MCP links, 1 WhatsApp delivered |
| Deployment | Vercel (Mumbai) + Supabase Postgres (ap-south-1) |
