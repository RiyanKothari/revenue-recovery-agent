import { getDb, type RecoveryDb } from "./db";
import { logAudit } from "./audit";
import type { Classification } from "./classifier";
import {
  ALLOWED_ACTIONS,
  resolveDecisionModel,
  type DecisionModel,
} from "./decision-model";

/**
 * The agent. Deliberately narrow: it is NEVER asked "what should we do,"
 * it is asked "which of these three pre-approved actions fits best, and
 * why." Guardrails (guardrails.ts) already vetoed anything unsafe before
 * this function is even called — the LLM cannot reach an action that
 * wasn't already allowed. What it DOES decide: which channel, what tone,
 * and it must produce a rationale — that rationale is the explainability
 * artifact the submission bar asks for, not a nice-to-have.
 *
 * Nothing below is provider-specific. The model sits behind an adapter
 * (decision-model.ts) so switching providers cannot disturb the fail-closed
 * paths, which are the only paths here worth testing.
 */

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

const SYSTEM_PROMPT = `You are a payment-recovery decision agent. You may ONLY choose one action from this fixed list:
- send_retry_link_whatsapp
- send_retry_link_email
- escalate_human

You are never allowed to invent a new action, change the payment amount, or waive a guardrail. Guardrails have already been checked before you are called — you are only choosing HOW to act, not whether to. Always explain your reasoning in one or two plain sentences, referencing the root cause and retry history.`;

/**
 * Injected so the fail-closed behaviour can be tested without calling any
 * API. The interesting paths here are all failure paths — a refusal, a
 * truncated response, an action outside the allowed set — and none of them
 * are reachable by asking a real model nicely.
 */
export interface DecisionDeps {
  model: DecisionModel;
  db: Pick<RecoveryDb, "insertDecision">;
  audit: typeof logAudit;
}

export async function decide(
  input: DecisionInput,
  deps: Partial<DecisionDeps> = {}
): Promise<Decision> {
  const model = deps.model ?? resolveDecisionModel();
  const db = deps.db ?? getDb();
  const audit = deps.audit ?? logAudit;

  const userPrompt = `Root cause: ${input.classification.root_cause}
Payment method: ${input.classification.payment_method}
Amount at risk: ₹${(input.amountPaise / 100).toFixed(2)}
Prior attempts this event: ${JSON.stringify(input.customerRetryHistory)}

Choose the best action and explain why.`;

  const response = await model.complete({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 300,
  });

  // Fail closed: a refusal, a truncated response, or anything outside the
  // schema becomes a human escalation rather than an executed action. The
  // schema makes an out-of-bounds action unreachable in the happy path; this
  // is the guardrail catching everything else.
  let parsed: { action: AgentAction; rationale: string } | null = null;
  if (response.stopReason !== "refusal" && response.text) {
    // JSON.parse was previously unguarded. A max_tokens truncation returns a
    // valid JSON *prefix* that throws here, which would have crashed the
    // webhook on the exact path meant to degrade safely into escalation.
    try {
      const candidate = JSON.parse(response.text) as {
        action: string;
        rationale: string;
      };
      if (
        ALLOWED_ACTIONS.includes(candidate.action as AgentAction) &&
        typeof candidate.rationale === "string"
      ) {
        parsed = candidate as { action: AgentAction; rationale: string };
      }
    } catch {
      parsed = null; // handled by the escalation fallback below
    }
  }

  const decision = parsed
    ? { action: parsed.action, rationale: parsed.rationale, boundedBy: [] as string[] }
    : {
        action: "escalate_human" as AgentAction,
        rationale: `Agent did not return a usable in-bounds decision (stop_reason=${response.stopReason}); escalated to human review instead.`,
        boundedBy: ["fixed_action_set"],
      };

  const saved = await db.insertDecision({
    revenue_event_id: input.revenueEventId,
    root_cause: input.classification.root_cause,
    chosen_action: decision.action,
    rationale: decision.rationale,
    bounded_by: decision.boundedBy,
  });

  if (!parsed) {
    await audit(input.revenueEventId, "stopping_rule_triggered", {
      reason: "agent_returned_unusable_decision",
      stop_reason: response.stopReason,
      model: model.name,
    });
  }

  await audit(input.revenueEventId, "agent_decided", {
    decision_id: saved.id,
    action: decision.action,
    rationale: decision.rationale,
    model: model.name,
  });

  return { ...decision, decisionId: saved.id };
}
