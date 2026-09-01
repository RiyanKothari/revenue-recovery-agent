import { getDb, type RecoveryDb } from "./db";
import { logAudit } from "./audit";
import type { Classification } from "./classifier";
import {
  ALLOWED_ACTIONS,
  resolveDecisionModel,
  type DecisionModel,
} from "./decision-model";
import { decisionContextKey, decisionPrompt } from "./decision-cache";

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
  db: Pick<RecoveryDb, "insertDecision" | "getCachedDecision" | "putCachedDecision">;
  audit: typeof logAudit;
  /** Set false to force a fresh model call — used when comparing cached
   *  answers against live ones. */
  useCache: boolean;
}

export async function decide(
  input: DecisionInput,
  deps: Partial<DecisionDeps> = {}
): Promise<Decision> {
  const model = deps.model ?? resolveDecisionModel();
  const db = deps.db ?? getDb();
  const audit = deps.audit ?? logAudit;
  const useCache = deps.useCache ?? true;

  // The prompt and the cache key come from the same inputs, so a cached
  // rationale is always true of the event reusing it. See decision-cache.ts.
  const cacheKey = decisionContextKey(input);
  const userPrompt = decisionPrompt(input);

  /**
   * A previously reasoned answer to this exact situation.
   *
   * This is what makes a batch of hundreds affordable: across 800 failures
   * there are only a few dozen distinct decision contexts, and at temperature
   * 0 the model returns the same answer for each. Reuse is recorded on the
   * decision row and in the audit trail, so the trail never implies more
   * reasoning than happened.
   */
  const cached = useCache && db.getCachedDecision
    ? await db.getCachedDecision(cacheKey).catch(() => null)
    : null;

  if (cached) {
    const saved = await db.insertDecision({
      revenue_event_id: input.revenueEventId,
      root_cause: input.classification.root_cause,
      chosen_action: cached.chosen_action,
      rationale: cached.rationale,
      bounded_by: [],
      from_cache: true,
      cache_key: cacheKey,
    });

    await audit(input.revenueEventId, "agent_decided", {
      decision_id: saved.id,
      action: cached.chosen_action,
      rationale: cached.rationale,
      model: cached.model,
      from_cache: true,
      cache_key: cacheKey,
    });

    return {
      action: cached.chosen_action as AgentAction,
      rationale: cached.rationale,
      boundedBy: [],
      decisionId: saved.id,
    };
  }

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
    from_cache: false,
    cache_key: cacheKey,
  });

  // Only successful, in-bounds decisions are memoised. Caching an escalation
  // caused by a truncated response or a provider blip would turn one
  // transient failure into a permanent one for that whole situation.
  if (parsed && useCache && db.putCachedDecision) {
    await db
      .putCachedDecision({
        cache_key: cacheKey,
        chosen_action: decision.action,
        rationale: decision.rationale,
        model: model.name,
      })
      .catch((err) => console.error("[decision-cache] write failed:", err?.message ?? err));
  }

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
    from_cache: false,
    cache_key: cacheKey,
  });

  return { ...decision, decisionId: saved.id };
}
