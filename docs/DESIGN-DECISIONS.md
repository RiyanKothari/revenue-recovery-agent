# Important Decisions

This is the "important decisions" section of the pitch, in writing — pull from this directly for the video, don't re-derive it from scratch.

## Rules-plus-LLM, not pure LLM
The agent (`lib/decision-engine.ts`) never decides *whether* to act — guardrails (`lib/guardrails.ts`) decide that deterministically, before the LLM is even called. The LLM only chooses *how*, from a fixed set of three actions, and must produce a written rationale. Reasoning: financial actions need to be bounded by code, not by prompting — a hallucinated action should be structurally impossible, not just discouraged. This is what "explainable, bounded, gated" means as an architecture, not a slogan.

## One tight loop, not five shallow ones
The brief lists seven example directions. This project builds one — payment failure → root cause → recovery — end to end, with UPI mandate retry as the only stretch goal, chosen because it directly parallels Razorpay's own Sprint 2026 launch rather than being a second unrelated trigger type. Reasoning: a judge evaluating "implementation" and "proof of work" is better served by one loop that provably works than three that don't.

## Razorpay's own agent infrastructure, not a REST wrapper
The action executor calls Razorpay's official hosted MCP server (`mcp.razorpay.com`) rather than hand-rolling calls to the Payment Links API. Reasoning: Razorpay built this specifically for AI agents to take payment actions — using it is the most direct way to show this project understands and extends their actual product surface, not just their public docs.

## Razorpay's own design system, not a custom dark theme
The dashboard is built on `@razorpay/blade` — the design system that powers Razorpay's own dashboards, websites, and apps (not just a public component library). Reasoning: same logic as the MCP choice — build with what they actually use internally, not an approximation of their aesthetic.

## Synthetic batch, real pipeline
`scripts/generate-synthetic-batch.ts` doesn't insert directly into the database — it POSTs signed, realistic events through the same webhook route real Razorpay traffic hits. Reasoning: the measured batch numbers need to come from the real pipeline, or they don't mean anything.

## Fail closed on unknown root causes
`classifier.ts` marks unrecognized failure reasons as `is_recoverable: false`, routing them to human escalation rather than guessing. Reasoning: an agent that's honest about what it doesn't understand is more trustworthy than one that always has an answer — and the submission bar explicitly asks for an honest exception list, not a 100% automation claim.

## Fail closed on *every* path, including infrastructure failure
Not just unknown root causes. Every guardrail check inspects its database error and refuses when it cannot be evaluated; the executor throws rather than continue if a recovery action cannot be recorded; the decision engine treats a truncated or unparseable model response as an escalation. Reasoning: the first version of the guardrails dropped `error` from each query, so a database blip silently returned "allowed" for all four rules at once — DND opt-outs included. Fail-open is what you get for free from `const { data } = await ...`; safety code has to state its failure direction explicitly. This is the difference between guardrails that hold under failure and guardrails that only hold when nothing is wrong.

## The write path must never blind the read path
`guardrails.ts` enforces the retry ceiling and cooldown by *counting rows* that `action-executor.ts` writes. So the executor's inserts are checked, and a failure throws instead of continuing — an action that happened but wasn't recorded is worse than one that never happened, because the customer was contacted and no guardrail can see it. Throwing is safe here specifically because the webhook's idempotency check short-circuits Razorpay's retry on the existing event, so it cannot cause a second send. Reasoning: a stateful safety rule is only as good as the writes it reads.

## Safety code is dependency-injected so it can be tested against failure
Guardrails, the executor and the decision engine all take their database, API client and audit logger as injectable parameters. Reasoning: the interesting behaviour of safety code is what it does when things break, and none of that is reachable by calling the real services and hoping. This is what makes it possible to assert "a total database outage blocks rather than allows" as a test rather than a claim — 51 tests run with no credentials at all.

## Two recovery rates, because one number would be dishonest
The dashboard reports `recovery_rate` (of everything that failed, how much came back) *and* `recovery_rate_attempted` (of what the agent actually acted on, how much converted). Reasoning: dividing by all failures understates the agent, since it deliberately never touches unknown root causes; dividing only by attempts overstates the business outcome. Reporting one number would have meant picking which way to be misleading.

## A holdout arm, because attributed recovery isn't measured recovery
A deterministic slice of otherwise-eligible events (default 10%) is left **untreated on purpose**. Reasoning: "we messaged 200 people and recovered ₹4.2L" credits the agent for every customer who would have retried on their own — which is most of the honest uncertainty in this project. The control arm establishes the do-nothing baseline, and the gap between arms is recovery the agent actually *caused*. The bar for this track says "show measured money recovered"; without a control group, the number is attributed, not measured.

Assignment is a pure function of the event id (SHA-256, fixed salt), so it survives webhook retries, needs no stored state to be reproducible, and stays monotonic when the holdout percentage changes — raising it from 10% to 20% keeps the original control group rather than reshuffling everyone and invalidating the comparison.

## Expected value before the model, not after
A deterministic gate computes `P(recover) × amount × margin − cost(action)` and refuses anything unprofitable *before* the LLM is called. Reasoning: guardrails answer "are we allowed to act"; this answers "is acting worth it". Gross recovery cannot see cost, so an agent optimising it will happily spend ₹50 of human escalation time chasing a ₹40 failure and report the result as a win. This also gives the bounded-agent story a second, quantitative leg — an economically irrational action is never in the model's reach, rather than merely discouraged by prompt wording.

`P(recover)` is a Beta-binomial estimate that starts from priors grounded in what each root cause physically means (a bank timeout had a valid payment method; a decline needs the customer to fix something) and is progressively dominated by the pipeline's own observed outcomes. That is the feedback loop the brief asks for — the economics sharpen as the system runs, using the outcomes table it already maintains.

## Declining to act is a result, not a failure
The dashboard separates "could not resolve" (DND, cooldown, retry ceiling, unrecognised failure) from "declined on purpose" (holdout control, negative expected value). Reasoning: listing a deliberate economic decision alongside genuine failures misrepresents judgment as a shortcoming. An agent that declines 140 events *because chasing them was unprofitable*, with the arithmetic on screen, is demonstrating something stronger than one that acts everywhere.

## The dashboard is ledger-first, not metrics-first
The live reasoning feed is the widest column and the visual anchor; the summary stats sit compact above it. The UI also never prints an internal identifier — actions read "Sent via WhatsApp", stopping reasons read "Reached cooldown window". Reasoning: the moment that proves this is a real agent is watching it reason about a specific failure and say why, in words. Metrics prove the outcome; the feed proves the mechanism, and the mechanism is what's actually novel here.
