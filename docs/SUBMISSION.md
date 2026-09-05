# Buildathon submission answers

Five days, solo, built against Razorpay test mode from a cold start.
Every number here comes from the deployed instance, not a local run.

---

## Project Name

**Revenue Recovery Desk**

*(If the field allows a subtitle: "an auditable agent for failed-payment
recovery")*

---

## Project Objectives: what does it solve?

About a quarter of failed Razorpay payments are recoverable. The card had no
balance at 2pm and has one at 6pm. The bank timed out. The network dropped
halfway through authorisation. Sending a nudge is the easy part, and you could
do that with a cron job and forty lines of code.

The hard parts are the two nobody demos. Sending it to the right person at a
moment that helps, without messaging someone who explicitly asked you never to
contact them. And then proving the money came back *because* you acted, rather
than coincidentally after you did.

This is a bounded agent sitting on Razorpay's webhook stream, and it does three
things most recovery tools skip.

**It is gated in code, not in a prompt.** Every failed payment is classified
deterministically, then run through four guardrails (consent, retry ceiling,
cooldown, refund and dispute kill switch) and an expected value gate. Only then
is a model asked anything, and it is only ever asked *which* of three
pre-approved actions fits. Never *whether* to act. Every safety check fails
closed, so a rule that cannot be evaluated refuses instead of proceeding.
Execution runs through Razorpay's own MCP server and the WhatsApp Cloud API.

**It proves the money came back because of it.** Ten percent of otherwise
eligible events are deliberately left untreated as a holdout, so recovery is
measured against a do-nothing baseline instead of attributed to whatever
happened after a message. On the deployed instance the treated arm recovers at
33.1% against the holdout's 12.1%. That is **+21.0pp lift, 95% CI [14.1, 27.9],
₹7,56,982 incremental**. The panel also reports the smallest effect this
holdout could have detected, so a null result reads as "this experiment was too
small to tell" rather than "the agent did not work". Those are completely
different statements, and most dashboards render them identically.

**It can prove the safety rules actually held.** A conformance verifier
re-derives seven invariants from the recorded audit trail using code that
shares nothing with the guardrails that enforce them. **5,346 checks, zero
violations.** This is the piece that earned its keep. During development it
caught a real consent violation that every other signal in the system reported
as a success. A companion Red Team screen attacks the live deployment with ten
hostile inputs and shows each one being refused, because a fail-closed
guardrail looks exactly like no guardrail until something attacks it.

**And it has done all of this on real Razorpay traffic.** Six genuine
`payment.failed` events reached the deployed instance, producing three real
payment links through Razorpay's MCP server and a WhatsApp message that arrived
on a phone at 5:46pm. Three guardrails refused real events along the way.
Signature verification rejected six deliveries while a secret was unset in
Vercel, and the cooldown blocked a second nudge to a customer who had been
contacted eighteen minutes earlier.

The system is honest about its limits on screen. The 1,200 event demo batch is
synthetic and the dashboard says so in a permanent amber banner, because the
entire thesis is separating what was measured from what was assumed. A
dashboard that hides its own provenance forfeits that at the first hard
question.

---

## GitHub Repository URL

```
https://github.com/RiyanKothari/revenue-recovery-agent
```

**Live deployment:** https://revenue-recovery-agent-plum.vercel.app/dashboard

---

## 5-min Pitch Video Link

*(Paste your link here. Beat by beat script is in `docs/DEMO-SCRIPT.md`.)*

---

## Build Challenges and Technical Obstacles

Ten things that changed the system. Most of these exist only because I pointed
it at real Razorpay test traffic instead of my own fixtures, and every one of
them cost me hours I had not planned for.

### 1. My webhook signature check had an authentication bypass, and it looked fine

`crypto.createHmac("sha256", "")` does not throw. It computes a perfectly valid
HMAC using an empty key.

So with `RAZORPAY_WEBHOOK_SECRET` unset or blank, my verification still ran,
still looked rigorous, and passed for anybody able to compute an HMAC with a
key that is public knowledge. My own `.env.local` template ships that variable
blank, which means "unconfigured" was the default state of a fresh clone of my
repo. Someone could have posted fabricated payment failures and had my agent
create real payment links.

I found it by asking a question I nearly did not bother asking: what happens if
this variable is empty? It now refuses a missing or empty secret at the point
of use, rather than trusting me to configure it correctly, and there are tests
that forge the empty-key signature and assert refusal.

It stopped being hypothetical the same day. When I deployed, I forgot that
variable in Vercel, and the fix refused six real Razorpay deliveries instead of
accepting them.

### 2. Razorpay test mode caps you at 30 payment links, and I diagnosed it wrong twice

This cost me most of an afternoon, and it is the most Razorpay-specific thing I
learned in five days.

My MCP calls started failing partway through a batch. My first theory was a
cached rejected promise in my MCP client, so I rewrote the client. Still
failed. My second theory was a bundling problem with the MCP SDK under Next.js,
so I restructured the import. Still failed.

The actual answer is that Razorpay test mode allows thirty payment links per
account in total. Not thirty per minute. Thirty, ever. I had burned through
mine, and every call past that limit fails with an error that reads like a
transient fault.

Two things came out of it. I stopped trusting my first instinct on an opaque
error and started reading the raw response body before theorising. And, more
importantly for the product, I realised an exhausted test account is a
**configuration** problem and not a **customer** outcome. My dashboard had
filled with hundreds of "delivery failed" rows implying real people had not
received a message that was never actually sent. The budget is now rationed
before the call rather than discovered after the failure, over-quota links are
marked `simulated` on screen, and the audit trail names the culprit as our
quota rather than their phone.

The same lesson applied twice more. An expired WhatsApp token returning
OAuthException 190 on every send, and a Meta proxy returning a 502 with an HTML
body straight into an unguarded `JSON.parse`.

### 3. Failing a payment on purpose in Razorpay test mode is weirdly hard

I needed real `payment.failed` events, and it took several attempts to produce
one.

Test cards route through an OTP screen. Entering a wrong OTP gives you
"verification failed", so my first instinct was to skip the OTP, which produced
a state I did not expect. Then it asked me for a six digit OTP again. I
eventually got clean failures, and then failed several more with different
numbers so the cooldown was exercised against genuinely different customers
rather than the same one twice.

It sounds trivial written down. It is not trivial at 1am when your entire
pipeline is waiting on an event that will not arrive and you cannot tell
whether the problem is Razorpay, your webhook URL, your signature check or the
tunnel. What actually unblocked me was making the dashboard display refused
events *and the reason*, so a webhook that arrived and was rejected looks
different from a webhook that never arrived at all.

### 4. Real payloads exposed a classifier I had written against my own fixtures

My synthetic generator emitted an error code and a prose description, so every
classifier rule I wrote was a pattern tuned against sentences I had written
myself. It scored beautifully on my own data.

A genuine Razorpay failure arrives with `error_description: "Payment failed"`.
That carries nothing. The actual cause sits two keys away in `error_reason` and
`error_source`, and I was reading neither.

So my real events classified as `unknown` and went to human review. That is
correct behaviour given the information available, and it was the wrong
information to have been looking at. The fixtures and the parser were wrong in
exactly the same direction, which is the failure mode synthetic testing cannot
detect by construction, because the same person wrote both.

I have deliberately left those two `unknown` rows in the production audit
trail. The classifier refusing to guess, and then real data teaching it
Razorpay's actual taxonomy, is a better story than a clean screen.

### 5. Concurrent webhook redeliveries produced two payment links for one customer

Razorpay delivered the same webhook twice at once. My idempotency check was a
read followed by a write, both requests interleaved between the two, and one
customer received two payment links four seconds apart.

That is precisely the harm my guardrails exist to prevent, and neither of them
caught it. The retry ceiling counts actions, and both requests read zero before
either wrote. The cooldown looks for contact in a window ending at the event's
own timestamp, which correctly excludes sends landing after it.

No amount of application level care closes that window. A unique constraint
does. My contract test fires three inserts concurrently, because the sequential
version of that test passes even without the constraint, which makes it worse
than having no test at all.

### 6. I was recording messages as delivered when Meta had only accepted them

Meta returns HTTP 200 with a message id for any recipient, and silently drops
messages to numbers that are not on your test number's allowed list.

Three messages were logged in my audit trail as delivered. None of them
arrived. On a project whose entire argument is an honest audit trail, asserting
delivery I could not evidence, with no message id stored to trace the claim,
was the worst available category of bug.

It now records Meta's own word, `accepted`, alongside the message id, and I
added a delivery callback endpoint so the real status can arrive
asynchronously. That callback is the only place the word "delivered" can
honestly come from.

Related lesson for anyone doing this from scratch: the token from Meta's API
Setup tab expires in about 24 hours. Mine died overnight and produced a screen
full of failures that looked like a delivery problem and were entirely mine. A
System User token does not expire.

### 7. My cooldown was asking about the wrong four hours

It measured backwards from `Date.now()` instead of from when the payment
actually failed.

Razorpay retries webhook deliveries with backoff, so a delayed event was being
asked "was this customer contacted in the four hours before *this moment*",
when the question is about the four hours before *the failure*. Under a delayed
delivery those two windows do not overlap at all. The guardrail holds
perfectly, while examining entirely the wrong period.

I only found it because a counterfactual replay tool I had built showed the
cooldown slider moving nothing. Chasing that led to a second discovery, which
is that my synthetic batch had compressed a week of payment failures into
ninety seconds, so the cooldown had never once been genuinely exercised.

### 8. My "reproducible" demo was reproducible by accident, and then not at all

I had documented the generator as deterministic, so that a re-run produces the
same batch and the same measured numbers. Three `Math.random()` calls meant it
was not.

Two runs of identical code produced different measured lift. On one of them the
confidence interval crossed zero, and my dashboard reported the effect as
unestablished purely on the strength of a different random draw.

Seeding fixed that, but the seed had to be keyed on the Razorpay *order* id
rather than the database row id, because the row id is a generated UUID that
would have looked deterministic while reproducing nothing.

Making it genuinely reproducible then exposed the real problem underneath. A
10% holdout of 400 events yields roughly 33 control observations, and 33
observations cannot resolve a 15 point difference. The experiment was
underpowered before it ever ran. I fixed that with more volume at an honest
holdout, rather than by inflating the holdout until the demo looked better.

### 9. Serving 900 decisions inside a 20 request per day model quota

I was building on a free tier with a hard daily cap, which turned out to be a
useful constraint rather than only an annoying one.

At temperature 0 the answer to a given situation is identical every time, and
1,200 payment failures contain only about 57 genuinely distinct decision
situations once you group by root cause, payment method, amount band and prior
attempts. So decisions are memoised on the situation rather than on the event.

The property that keeps it honest is that the cache key and the prompt are
derived from the same function, and the prompt carries an amount *band* rather
than the exact rupee figure. Two events sharing a key are therefore genuinely
indistinguishable to the agent, and a rationale written for one is true of the
other. Every reuse is flagged in the audit trail and on screen.

Result: **11 model calls served 908 decisions.** Failures are deliberately
never cached, because memoising an escalation caused by one truncated response
would make a single blip permanent for that entire situation.

### 10. A flaky test that was actually a defect in my fixture

I had an intermittent test failure. I saw it twice, could not reproduce it, and
had been honestly reporting it as unexplained right up until the last day.

Then I ran the suite in a loop instead of running it once and hoping. It
reproduced one run in three.

My synthetic generator was calling `Date.now()` once per *event* instead of
once per *batch*, so any run that straddled a second boundary stamped its
events from two different clocks. The visible symptom was a determinism test
comparing two generated batches and failing intermittently. The actual defect
was worse than the symptom, because a batch stamped from many clocks is not the
reproducible fixture my documentation had been promising, and the cooldown gaps
derived from those timestamps were off by a second in a way nothing would ever
have surfaced.

The generator is now a pure function of `(size, now)`. Eight consecutive clean
full runs since.

### Also worth noting

My MySQL implementation compiled for weeks without a single query ever
executing, which is a strange kind of "dual database support" to advertise.
Both drivers now run the same 30 case contract sequence and are asserted to
agree. It immediately found a query ordering by a column that does not exist.

And deployment day taught me two things the hard way. An in-memory rate limiter
does essentially nothing on serverless, which I measured rather than assumed:
thirty-four requests against a limit of thirty all returned 200, because the
platform had spread them across enough lambda instances that no single counter
reached its limit. That counter now lives in the database. Separately, Vercel
Hobby accounts cap a cron expression at once per day, which silently failed my
builds *before* they produced a deployment, so production kept serving an older
commit while I stared at 404s on routes I had definitely written and pushed.

---

## Quick facts

| | |
|---|---|
| Build time | 5 days, solo |
| Stack | Next.js 14, TypeScript, Razorpay Blade, PostgreSQL and MySQL |
| Agent | Gemini through a provider agnostic adapter (Anthropic supported) |
| Execution | Razorpay MCP server (42 tools), WhatsApp Cloud API |
| Tests | 311, including a 30 case dual driver database contract suite, running in CI |
| Conformance | 7 invariants, 5,346 checks, 0 violations |
| Red Team | 10 hostile inputs against the live defences, all refused |
| Real traffic | 6 genuine Razorpay events, 3 real MCP links, 1 WhatsApp delivered |
| Model economy | 11 model calls served 908 decisions |
| Deployment | Vercel (Mumbai) and Supabase Postgres (ap-south-1) |

---

## If a judge asks

**"Is any of this real?"**
The pipeline is entirely real. Six genuine Razorpay events went through the
deployed instance, produced three real payment links through the MCP server,
and one WhatsApp that arrived on my phone. The 1,200 event batch behind the
lift figure is synthetic and labelled as such on screen. Recoveries there are
simulated from a stated assumption.

**"So the 21 point lift is fake?"**
The measurement machinery is real. The customer behaviour is not. That number
proves the holdout arithmetic, the attribution window and the confidence
interval all work correctly. It does not prove a real conversion rate, and
nothing built in five days without a live merchant could. I would rather say
that first than have it extracted from me.

**"What happens if the model returns garbage?"**
Human escalation. A refusal, a truncated response, or anything outside the
three approved actions all become escalations rather than actions. The JSON
schema is the first defence and not the only one.

**"How do you know the guardrails held?"**
The conformance panel. 5,346 checks, zero violations, and it is an independent
re-derivation from the audit trail rather than a restatement of what the
guardrails intended. It caught a real consent violation that every other signal
reported as success.

**"Does it scale?"**
Eleven model calls for nine hundred decisions answers cost. For throughput,
`audit_log` is append-only and event-shaped, so at volume the dashboard reads a
CDC stream rather than polling. The conformance verifier currently refuses
above 50,000 events rather than checking a subset, because a safety attestation
over part of the record is a clean bill of health for rows nobody looked at.

**"What is still broken?"**
Concurrent webhook redeliveries once produced two payment links for one event,
now fixed with a database constraint. And I spent most of five days reporting
an intermittent test failure as unexplained before I sat down and ran the suite
in a loop, at which point it reproduced in three minutes. That one is fixed
too, and the lesson there was mine rather than the code's.

**"What is next?"**
Widen past failed payments to checkout abandonment and mandate retries, since
the classifier already has room for both. And replace the Beta-binomial
propensity prior with a trained model once there is real outcome data, because
the expected value gate is already shaped for it.
