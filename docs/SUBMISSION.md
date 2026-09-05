# Buildathon submission answers

Five days, solo, built against Razorpay test mode from a cold start.
Every number comes from the deployed instance.

---

## Project Name

**Revenue Recovery Desk**

---

## Project Objectives: what does it solve?

About a quarter of failed Razorpay payments are recoverable. The card had no
balance at 2pm and has one at 6pm. The bank timed out. Sending a nudge is the
easy part, and a cron job could do it.

The hard parts are the two nobody demos: reaching the right person at a moment
that helps without messaging someone who asked you never to contact them, and
then proving the money came back *because* you acted rather than coincidentally
after you did.

**Gated in code, not in a prompt.** Every failure is classified
deterministically, then run through four guardrails (consent, retry ceiling,
cooldown, refund and dispute kill switch) and an expected value gate. Only then
is a model asked anything, and it is only ever asked *which* of three approved
actions fits. Never *whether* to act. Every check fails closed. Execution runs
through Razorpay's own MCP server and the WhatsApp Cloud API.

**It proves the money came back because of it.** Ten percent of eligible events
are deliberately left untreated, so recovery is measured against a do-nothing
baseline instead of attributed to whatever followed a message. Treated recovers
at 33.1%, holdout at 12.1%: **+21.0pp lift, 95% CI [14.1, 27.9], ₹7,56,982
incremental**. The panel also reports the smallest effect this holdout could
have detected, so "too small to tell" cannot be mistaken for "it did not work".

**It proves the safety rules held.** A verifier re-derives seven invariants
from the audit trail using code that shares nothing with the guardrails that
enforce them: **5,346 checks, zero violations**. It earned its keep by catching
a real consent violation that every other signal reported as success. A Red
Team screen then attacks the live deployment with ten hostile inputs, because a
fail-closed guardrail looks exactly like no guardrail until something attacks
it.

**On real traffic.** Six genuine `payment.failed` events reached the deployed
instance, producing three real payment links through the MCP server and a
WhatsApp that arrived on a phone. Guardrails refused real events along the way:
signature verification rejected six deliveries while a secret was unset, and
the cooldown blocked a second nudge to a customer contacted eighteen minutes
earlier.

The 1,200 event demo batch is synthetic, and the dashboard says so in a
permanent amber banner. The whole thesis is separating what was measured from
what was assumed, and a dashboard that hides its own provenance forfeits that
at the first hard question.

---

## GitHub Repository URL

```
https://github.com/RiyanKothari/revenue-recovery-agent
```

**Live:** https://revenue-recovery-agent-plum.vercel.app/dashboard

---

## 5-min Pitch Video Link

*(Paste your link. Script in `docs/DEMO-SCRIPT.md`.)*

---

## Build Challenges and Technical Obstacles

Ten that changed the system. Most exist only because I pointed it at real
Razorpay traffic instead of my own fixtures.

**1. My webhook signature check had an authentication bypass, and it looked
fine.** `crypto.createHmac("sha256", "")` does not throw. It computes a valid
HMAC with an empty key. So with `RAZORPAY_WEBHOOK_SECRET` blank, verification
still ran, still looked rigorous, and passed for anyone able to HMAC with a key
that is public knowledge. My `.env.local` template ships it blank, so
"unconfigured" was the default state of a fresh clone. I found it by asking
what happens if the variable is empty. It stopped being hypothetical the same
day: I forgot that variable in Vercel, and the fix refused six real Razorpay
deliveries instead of accepting them.

**2. Razorpay test mode caps you at 30 payment links, and I diagnosed it wrong
twice.** My MCP calls started failing partway through a batch. First theory: a
cached rejected promise, so I rewrote the client. Still failed. Second theory:
an MCP bundling problem under Next.js, so I restructured the import. Still
failed. The answer is thirty links per account in total. Not per minute.
Thirty, ever. Past that, every call fails with an error that reads like a
transient fault. Two lessons: read the raw response body before theorising, and
an exhausted test account is a **configuration** problem, not a **customer**
outcome. My dashboard had filled with hundreds of "delivery failed" rows for
messages that were never sent. Links are now rationed before the call and
marked `simulated` on screen.

**3. Failing a payment on purpose in test mode is weirdly hard.** Test cards
route through an OTP screen. A wrong OTP gives "verification failed", so I
skipped the OTP, which produced a state I did not expect, and then it asked for
six digits again. It sounds trivial written down. It is not trivial at 1am when
your pipeline is waiting on an event that will not arrive and you cannot tell
whether the problem is Razorpay, your webhook URL, your signature check or the
tunnel. What unblocked me was making the dashboard show refused events *and the
reason*, so a webhook that arrived and was rejected looks different from one
that never arrived.

**4. Real payloads exposed a classifier written against my own fixtures.** My
generator emitted prose I had written myself, so every classifier rule was a
pattern tuned to my own sentences. A genuine Razorpay failure arrives with
`error_description: "Payment failed"`, which carries nothing, and the real cause
two keys away in `error_reason` and `error_source`, which I was not reading. So
real events classified as `unknown` and went to human review: correct behaviour
on the available information, and the wrong information to be looking at. The
fixtures and the parser were wrong in the same direction, which is the failure
mode synthetic testing cannot detect by construction. I left those `unknown`
rows in the production trail on purpose.

**5. Concurrent redeliveries produced two payment links for one customer.**
Razorpay delivered the same webhook twice at once. My idempotency check was a
read followed by a write, the two requests interleaved between them, and one
customer got two links four seconds apart. Neither guardrail caught it: the
retry ceiling counts actions and both read zero before either wrote, and the
cooldown's window ends at the event's own timestamp, correctly excluding sends
that land after it. No application level care closes that window. A unique
constraint does. My test fires three inserts concurrently, because the
sequential version passes without the constraint, which makes it worse than no
test.

**6. I recorded messages as delivered when Meta had only accepted them.** Meta
returns 200 with a message id for any recipient and silently drops messages to
numbers not on your allowed list. Three messages were logged as delivered and
none arrived. On a project whose whole argument is an honest audit trail,
claiming delivery I could not evidence was the worst available category of bug.
It now records Meta's own word, `accepted`, with the message id, and a delivery
callback endpoint takes the real status asynchronously. Related: the token from
Meta's API Setup tab expires in about 24 hours. Mine died overnight and
produced a screen of failures that looked like a delivery problem and were
entirely mine.

**7. My cooldown was asking about the wrong four hours.** It measured back from
`Date.now()` instead of from when the payment failed. Razorpay retries webhooks
with backoff, so a delayed event was asked "was this customer contacted in the
four hours before *this moment*" when the question is about the four hours
before *the failure*. Under a delayed delivery those windows do not overlap at
all, so the guardrail holds perfectly while examining the wrong period. I found
it because my replay tool showed the cooldown slider moving nothing, which then
revealed that my synthetic batch had compressed a week of failures into ninety
seconds and never exercised the rule once.

**8. My "reproducible" demo was reproducible by accident, then not at all.** I
had documented the generator as deterministic. Three `Math.random()` calls meant
it was not, and two runs of identical code produced different measured lift. On
one, the confidence interval crossed zero and the dashboard reported the effect
as unestablished purely on a different draw. The seed had to key on the Razorpay
*order* id rather than the database row id, because the row id is a generated
UUID that would have looked deterministic while reproducing nothing. Fixing it
then exposed the real problem: a 10% holdout of 400 events yields about 33
control observations, and 33 observations cannot resolve a 15 point difference.
The experiment was underpowered before it ran. I fixed that with more volume,
not by inflating the holdout until the demo looked better.

**9. Serving 900 decisions inside a 20 request per day model quota.** At
temperature 0 the answer to a given situation is identical every time, and
1,200 failures contain only about 57 distinct situations once grouped by root
cause, method, amount band and prior attempts. So decisions are memoised on the
situation, not the event. What keeps it honest: the cache key and the prompt
derive from the same function, and the prompt carries an amount *band* rather
than the exact figure, so two events sharing a key are genuinely
indistinguishable and a rationale written for one is true of the other.
**11 model calls served 908 decisions.** Failures are never cached, because
memoising an escalation caused by one truncated response would make a single
blip permanent for that whole situation.

**10. A flaky test that was actually a defect in my fixture.** I saw it twice,
could not reproduce it, and had been honestly reporting it as unexplained. On
the last day I ran the suite in a loop instead of running it once and hoping.
It reproduced one run in three. My generator called `Date.now()` once per
*event* instead of once per *batch*, so any run straddling a second boundary
stamped its events from two clocks. The symptom was a flaky determinism test.
The defect was that a batch stamped from many clocks is not the reproducible
fixture my docs had been promising, and the cooldown gaps derived from those
timestamps were off by a second in a way nothing would have surfaced. Eight
clean full runs since.

**Also:** my MySQL implementation compiled for weeks without a single query
ever executing, which is a strange kind of "dual database support" to
advertise. Both drivers now run the same 30 case contract sequence and are
asserted to agree; it immediately found a query ordering by a column that does
not exist. And deployment day taught me that an in-memory rate limiter does
almost nothing on serverless, measured rather than assumed (thirty-four
requests against a limit of thirty all returned 200, spread across lambdas so
no counter reached its limit), and that Vercel Hobby caps a cron at once per
day, which failed my builds *before* they produced a deployment while I stared
at 404s on routes I had definitely pushed.

---

## Quick facts

| | |
|---|---|
| Build time | 5 days, solo |
| Stack | Next.js 14, TypeScript, Razorpay Blade, PostgreSQL and MySQL |
| Agent | Gemini through a provider agnostic adapter (Anthropic supported) |
| Execution | Razorpay MCP server (42 tools), WhatsApp Cloud API |
| Tests | 311, incl. a 30 case dual driver contract suite, running in CI |
| Conformance | 7 invariants, 5,346 checks, 0 violations |
| Red Team | 10 hostile inputs against live defences, all refused |
| Real traffic | 6 genuine Razorpay events, 3 real MCP links, 1 WhatsApp delivered |
| Model economy | 11 model calls served 908 decisions |
| Deployment | Vercel (Mumbai) and Supabase Postgres (ap-south-1) |

---

## If a judge asks

**"Is any of this real?"** The pipeline is. Six genuine Razorpay events went
through the deployed instance, produced three real payment links through the
MCP server, and one WhatsApp that arrived on my phone. The 1,200 event batch
behind the lift figure is synthetic and labelled as such on screen.

**"So the 21 point lift is fake?"** The measurement machinery is real. The
customer behaviour is not. That number proves the holdout arithmetic, the
attribution window and the confidence interval all work. It does not prove a
real conversion rate, and nothing built in five days without a live merchant
could. I would rather say that first than have it extracted from me.

**"What if the model returns garbage?"** Human escalation. A refusal, a
truncated response, or anything outside the three approved actions all become
escalations rather than actions.

**"How do you know the guardrails held?"** The conformance panel: 5,346 checks,
zero violations, and an independent re-derivation from the audit trail rather
than a restatement of what the guardrails intended.

**"Does it scale?"** Eleven model calls for nine hundred decisions answers
cost. For throughput, `audit_log` is append-only and event-shaped, so at volume
the dashboard reads a CDC stream rather than polling. The verifier refuses
above 50,000 events rather than checking a subset, because a safety attestation
over part of the record is a clean bill of health for rows nobody looked at.

**"What is still broken?"** Concurrent redeliveries once produced two links for
one event, now fixed with a database constraint. And I reported an intermittent
test failure as unexplained for days before I sat down and ran the suite in a
loop, at which point it reproduced in three minutes. That lesson was mine
rather than the code's.

**"What is next?"** Checkout abandonment and mandate retries, since the
classifier already has room for both. And replacing the Beta-binomial
propensity prior with a trained model once there is real outcome data, because
the expected value gate is already shaped for it.
