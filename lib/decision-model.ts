import Anthropic from "@anthropic-ai/sdk";

/**
 * The model behind the decision engine, behind one interface.
 *
 * Only the transport differs between providers. Everything that makes the
 * agent safe — validating the action against the allowed set, requiring a
 * rationale, and turning anything unusable into a human escalation — lives in
 * decision-engine.ts and is provider-agnostic by construction. That matters
 * more than it sounds: those are the paths under test, and swapping providers
 * must not touch them.
 *
 * Provider is chosen by which key is present, so the pipeline runs on
 * whichever one you have.
 */

export interface ModelResponse {
  /** The raw JSON text the model produced, or null if it produced none. */
  text: string | null;
  /**
   * Normalised across providers. "refusal" specifically means the model
   * declined — the decision engine treats it as an escalation, so each
   * adapter must map its own vocabulary onto it rather than leaking
   * provider-specific strings upward.
   */
  stopReason: string;
}

export interface DecisionModel {
  readonly name: string;
  complete(params: {
    system: string;
    user: string;
    maxTokens: number;
  }): Promise<ModelResponse>;
}

/** The one shape a decision may take. Expressed per-provider below. */
export const ALLOWED_ACTIONS = [
  "send_retry_link_whatsapp",
  "send_retry_link_email",
  "escalate_human",
] as const;

// --- Anthropic -------------------------------------------------------------

const ANTHROPIC_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ALLOWED_ACTIONS },
    rationale: { type: "string" },
  },
  required: ["action", "rationale"],
  additionalProperties: false,
} as const;

export function createAnthropicModel(apiKey: string, model = "claude-sonnet-5"): DecisionModel {
  const client = new Anthropic({ apiKey });

  return {
    name: `anthropic:${model}`,

    async complete({ system, user, maxTokens }) {
      // Thinking is disabled deliberately: this is a bounded 3-way choice on
      // a webhook's critical path, and adaptive thinking would spend the
      // token budget on reasoning and truncate the answer.
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        thinking: { type: "disabled" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: ANTHROPIC_SCHEMA },
        },
        system,
        messages: [{ role: "user", content: user }],
      });

      const block = response.content.find((b) => b.type === "text");
      return {
        text: block?.type === "text" ? block.text : null,
        stopReason: response.stop_reason ?? "unknown",
      };
    },
  };
}

// --- Gemini ----------------------------------------------------------------

/**
 * Gemini wants an OpenAPI-flavoured schema with upper-case type names, and
 * rejects `additionalProperties`. Declared separately rather than translated,
 * because a silently-dropped constraint is worse than a duplicated one — and
 * the decision engine re-validates the action against ALLOWED_ACTIONS
 * regardless, so the schema is the first line of defence, not the only one.
 */
/**
 * Gemini 3.x reasons before answering and cannot be told not to —
 * `thinkingBudget: 0` is rejected outright — and those thinking tokens are
 * charged against the SAME output budget as the answer.
 *
 * Measured on gemini-3.6-flash with this exact prompt: at maxOutputTokens
 * 300, thinking consumed 285 and the answer got 11, returning truncated
 * text and finishReason MAX_TOKENS. The fail-closed path handles that
 * correctly — unparseable output becomes a human escalation — which is
 * exactly why it would have been so hard to notice: the agent would have
 * escalated every single event and looked cautious rather than broken.
 *
 * So the adapter asks for the caller's answer budget plus room to think.
 */
const GEMINI_THINKING_HEADROOM = 1024;

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: [...ALLOWED_ACTIONS] },
    rationale: { type: "STRING" },
  },
  required: ["action", "rationale"],
};

/** Gemini's finish reasons, mapped onto the vocabulary above. */
function normaliseGeminiFinish(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    // The model declined. Anything in this family must reach the decision
    // engine as a refusal so it fails closed into human escalation.
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return reason ?? "unknown";
  }
}

export function createGeminiModel(
  apiKey: string,
  // Pinned rather than using a `-latest` alias: the model is part of what the
  // measured batch numbers mean, so it should not drift underneath a
  // published result. 2.5-flash still appears in ListModels but returns 404
  // on generateContent for new API keys.
  model = "gemini-3.6-flash"
): DecisionModel {
  return {
    name: `gemini:${model}`,

    async complete({ system, user, maxTokens }) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Gemini authenticates on this header (or ?key=), not Bearer.
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              maxOutputTokens: maxTokens + GEMINI_THINKING_HEADROOM,
              responseMimeType: "application/json",
              responseSchema: GEMINI_SCHEMA,
              temperature: 0,
            },
          }),
        }
      );

      const body: any = await res.json();

      if (!res.ok) {
        throw new Error(
          `Gemini request failed (HTTP ${res.status}): ${body?.error?.message ?? "unknown"}`
        );
      }

      // A prompt blocked before generation has no candidates at all.
      const blockReason = body?.promptFeedback?.blockReason;
      if (blockReason) {
        return { text: null, stopReason: "refusal" };
      }

      const candidate = body?.candidates?.[0];
      const text = candidate?.content?.parts
        ?.map((p: any) => p?.text ?? "")
        .join("")
        .trim();

      return {
        text: text || null,
        stopReason: normaliseGeminiFinish(candidate?.finishReason),
      };
    },
  };
}

// --- selection -------------------------------------------------------------

/**
 * Anthropic wins when both keys are present — it is the documented default
 * and the one the prompt was tuned against. Gemini is used when it is the
 * only key available.
 */
export function resolveDecisionModel(env = process.env): DecisionModel {
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicModel(env.ANTHROPIC_API_KEY, env.DECISION_MODEL);
  }

  if (env.GEMINI_API_KEY) {
    return createGeminiModel(env.GEMINI_API_KEY, env.DECISION_MODEL);
  }

  throw new Error(
    "No decision model configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.local — see docs/SETUP.md."
  );
}
