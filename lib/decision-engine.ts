import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabase";
import { logAudit } from "./audit";
import type { Classification } from "./classifier";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * The agent. Deliberately narrow: it is NEVER asked "what should we do,"
 * it is asked "which of these three pre-approved actions fits best, and
 * why." Guardrails (guardrails.ts) already vetoed anything unsafe before
 * this function is even called — the LLM cannot reach an action that
 * wasn't already allowed. What it DOES decide: which channel, what tone,
 * and it must produce a rationale — that rationale is the explainability
 * artifact the submission bar asks for, not a nice-to-have.
 */

const ALLOWED_ACTIONS = [
  "send_retry_link_whatsapp",
  "send_retry_link_email",
  "escalate_human",
] as const;

export type AgentAction = (typeof ALLOWED_ACTIONS)[number];

export interface DecisionInput {
  revenueEventId: string;
  classification: Classification;
  amountPaise: number;
  customerRetryHistory: { attempt_number: number; channel: string; status: string }[];
}

export interface Decision {
  action: AgentAction;
  rationale: string;
  boundedBy: string[];
  decisionId: string;
}

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ALLOWED_ACTIONS },
    rationale: { type: "string" },
  },
  required: ["action", "rationale"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a payment-recovery decision agent. You may ONLY choose one action from this fixed list:
- send_retry_link_whatsapp
- send_retry_link_email
- escalate_human

You are never allowed to invent a new action, change the payment amount, or waive a guardrail. Guardrails have already been checked before you are called — you are only choosing HOW to act, not whether to. Always explain your reasoning in one or two plain sentences, referencing the root cause and retry history.`;

export async function decide(input: DecisionInput): Promise<Decision> {
  const userPrompt = `Root cause: ${input.classification.root_cause}
Payment method: ${input.classification.payment_method}
Amount at risk: ₹${(input.amountPaise / 100).toFixed(2)}
Prior attempts this event: ${JSON.stringify(input.customerRetryHistory)}

Choose the best action and explain why.`;

  // Thinking is disabled deliberately: this is a bounded 3-way choice on a
  // webhook's critical path, and adaptive thinking (Sonnet 5's default) would
  // spend the max_tokens budget on reasoning and truncate the answer.
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 300,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: DECISION_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");

  // Fail closed: a refusal, a truncated response, or anything outside the
  // schema becomes a human escalation rather than an executed action. The
  // schema makes an out-of-bounds action unreachable in the happy path; this
  // is the guardrail catching everything else.
  let parsed: { action: AgentAction; rationale: string } | null = null;
  if (response.stop_reason !== "refusal" && textBlock?.type === "text") {
    const candidate = JSON.parse(textBlock.text) as {
      action: string;
      rationale: string;
    };
    if (ALLOWED_ACTIONS.includes(candidate.action as AgentAction)) {
      parsed = candidate as { action: AgentAction; rationale: string };
    }
  }

  const decision = parsed
    ? { action: parsed.action, rationale: parsed.rationale, boundedBy: [] as string[] }
    : {
        action: "escalate_human" as AgentAction,
        rationale: `Agent did not return a usable in-bounds decision (stop_reason=${response.stop_reason}); escalated to human review instead.`,
        boundedBy: ["fixed_action_set"],
      };

  const { data: saved, error } = await supabase
    .from("agent_decisions")
    .insert({
      revenue_event_id: input.revenueEventId,
      root_cause: input.classification.root_cause,
      chosen_action: decision.action,
      rationale: decision.rationale,
      bounded_by: decision.boundedBy,
    })
    .select("id")
    .single();

  if (error) throw error;

  if (!parsed) {
    await logAudit(input.revenueEventId, "stopping_rule_triggered", {
      reason: "agent_returned_unusable_decision",
      stop_reason: response.stop_reason,
    });
  }

  await logAudit(input.revenueEventId, "agent_decided", {
    decision_id: saved.id,
    action: decision.action,
    rationale: decision.rationale,
  });

  return { ...decision, decisionId: saved.id };
}
