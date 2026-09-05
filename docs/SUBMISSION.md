# Buildathon submission answers

Five days, solo, against Razorpay test mode from a cold start.
Every number is from the deployed instance.

---

## Project Name

**Revenue Recovery Desk**

---

## Project Objectives: what does it solve?

A quarter of failed Razorpay payments are recoverable. The card had no balance
at 2pm and has one at 6pm. Sending a nudge is the easy part, and a cron job
could do it.

The hard parts are the two nobody demos: reaching the right person without
messaging someone who asked you never to contact them, and proving the money
came back *because* you acted rather than coincidentally after you did.

**Gated in code, not in a prompt.** Four guardrails and an expected value gate
run before the model, which is only ever asked *which* of three approved
actions fits. Never *whether* to act. Every check fails closed. Execution goes
through Razorpay's own MCP server and the WhatsApp Cloud API.

**It measures instead of claiming.** Ten percent of eligible events are left
untreated as a holdout. Treated recovers at 33.1%, control at 12.1%:
**+21.0pp, 95% CI [14.1, 27.9], ₹7,56,982 incremental**. The panel also reports
the smallest effect the holdout could have detected, so "too small to tell"
cannot be mistaken for "it did not work".

**It proves the rules held.** A verifier re-derives seven invariants from the
audit trail using code sharing nothing with the guardrails that enforce them:
**5,346 checks, zero violations**. It caught a real consent violation that
every other signal reported as a success. A Red Team screen then attacks the
live deployment, because a fail-closed guardrail looks exactly like no
guardrail until something attacks it.

**On real traffic.** Six genuine `payment.failed` events, three real payment
links through the MCP server, one WhatsApp that arrived on a phone. Guardrails
refused real events too: six deliveries rejected while a secret was unset, and
a second nudge blocked to a customer contacted eighteen minutes earlier.

The 1,200 event demo batch is synthetic and the dashboard says so in permanent
amber. The whole thesis is separating what was measured from what was assumed,
and a dashboard hiding its own provenance forfeits that at the first hard
question.

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

Six that changed the system. Most exist only because I pointed it at real
Razorpay traffic instead of my own fixtures.

**1. An empty secret that verified everything.** `createHmac("sha256", "")`
does not throw. It quietly HMACs with a key everyone knows. My `.env` template
ships that secret blank, so an unconfigured clone accepted forged webhooks and
looked rigorous doing it. Anyone could have posted fake payment failures and
had my agent create real payment links. I then forgot the variable in Vercel
the same day, and the fix refused six real Razorpay deliveries.

**2. Thirty payment links. Ever. And I diagnosed it wrong twice.** My MCP calls
started failing mid-batch, so I rewrote the client for a cached-promise bug,
then restructured imports for a bundling bug. Neither existed. Razorpay test
mode allows thirty links per account in total, and everything past that fails
looking like a transient fault. Meanwhile my dashboard filled with "delivery
failed" rows for messages nobody was ever sent, which is how I learned that an
exhausted test account is a configuration problem and not a customer outcome.

**3. I wrote the fixtures and the parser, and got both wrong the same way.**
Real Razorpay failures arrive with `error_description: "Payment failed"`, which
says nothing, and the actual cause sits two keys away in `error_reason` and
`error_source`. My classifier had been reading prose I invented myself, so it
scored perfectly on my data and returned `unknown` on the real thing. Synthetic
testing cannot catch that by construction, because the same person writes both
sides. Those rows are still in the production audit trail on purpose.

**4. Accepted is not delivered.** Meta returns 200 with a message id for any
recipient, then silently drops numbers not on your allowed list. Three messages
were logged as delivered and none arrived, which on a project whose whole
argument is an honest audit trail is the worst bug available. It now records
Meta's own word alongside the id, and a callback endpoint takes the real status
later. Worth knowing if you are starting cold: Meta's API Setup tokens expire
in about 24 hours, and mine died overnight looking exactly like a delivery
failure.

**5. Two payment links, four seconds apart.** Razorpay delivered one webhook
twice at once. My idempotency check read and then wrote, the two requests
interleaved between them, and neither guardrail could see it: the retry ceiling
read zero twice, and the cooldown's window ends at the event's own timestamp.
That is exactly the harm the guardrails exist to prevent, and no amount of
application level care closes the gap. A unique constraint does. My test fires
three inserts concurrently, because the sequential version passes without it.

**6. Eleven model calls served 908 decisions.** A twenty request daily quota
forced memoisation on the *situation* rather than the event, since at
temperature 0 a thousand failures are only about 57 distinct situations. What
keeps it honest is that the cache key and the prompt come from one function,
and the prompt carries an amount band rather than an exact figure, so two
events sharing a key really are indistinguishable and a cached rationale is
true of either. Failures are never cached, because memoising one truncated
response would make a blip permanent.

**Also worth a line each:** my cooldown measured back from `Date.now()` instead
of from the failure, so under Razorpay's delivery backoff it held perfectly
while examining the wrong four hours. My "deterministic" demo generator called
`Date.now()` once per event instead of once per batch, which I spent days
calling a flaky test before running the suite in a loop and reproducing it one
run in three. And my MySQL driver compiled for weeks without a single query
ever executing, which is a strange kind of dual database support to advertise.

---

## Quick facts

| | |
|---|---|
| Build | 5 days, solo |
| Stack | Next.js 14, TypeScript, Razorpay Blade, PostgreSQL and MySQL |
| Agent | Gemini via a provider agnostic adapter |
| Execution | Razorpay MCP server (42 tools), WhatsApp Cloud API |
| Tests | 311, incl. a 30 case dual driver contract suite, in CI |
| Conformance | 7 invariants, 5,346 checks, 0 violations |
| Real traffic | 6 Razorpay events, 3 real MCP links, 1 WhatsApp delivered |
| Deployment | Vercel (Mumbai), Supabase Postgres (ap-south-1) |

---

## If a judge asks

**"Is any of this real?"** The pipeline is. Six genuine Razorpay events, three
real payment links, one WhatsApp on my phone. The 1,200 event batch behind the
lift figure is synthetic and labelled on screen.

**"So the lift is fake?"** The measurement machinery is real, the customer
behaviour is not. It proves the holdout arithmetic and the interval work. It
does not prove a conversion rate, and nothing built in five days without a live
merchant could. I would rather say that first than have it extracted from me.

**"What if the model returns garbage?"** Human escalation. Anything outside the
three approved actions becomes an escalation, not an action.

**"What is still broken?"** Concurrent redeliveries once produced two links for
one event, fixed with a database constraint. And I called a test flaky for days
before running it in a loop, at which point it reproduced in three minutes.
That one was my mistake, not the code's.
