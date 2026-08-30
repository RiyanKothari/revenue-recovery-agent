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
