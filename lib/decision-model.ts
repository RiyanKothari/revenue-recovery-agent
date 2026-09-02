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
 * Provider is chosen by DECISION_PROVIDER — explicitly, never by sniffing
 * which keys happen to be present. See resolveProviderName below.
 */

export interface ModelResponse {
  /** The raw JSON text the model produced, or null if it produced none. */
  text: string | null;
  /** Which model actually answered, when a fallback chain is in play. */
  model?: string;
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

// --- resilience ------------------------------------------------------------

/**
 * Transient provider failures are normal traffic, not exceptions.
 *
 * A single `503 high demand` from Gemini killed a 200-event batch run: the
 * adapter threw, the webhook 500'd, and the batch stopped. Over hundreds of
 * events a few transient failures are close to certain, so the model call
 * retries them rather than letting each one cost an event.
 *
 * Only retried for statuses that mean "try again" — rate limits, overload,
 * and upstream errors. A 400 or 404 is a bug in our request and retrying it
 * just wastes time and hides the cause.
 */
const RETRYABLE = /(429|500|502|503|504)/;
const MAX_ATTEMPTS = 4;

export function withRetry(model: DecisionModel): DecisionModel {
  return {
    name: model.name,
    async complete(params) {
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await model.complete(params);
        } catch (err: any) {
          lastError = err;
          const message = String(err?.message ?? err);
          const retryable = RETRYABLE.test(message) || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);

          if (!retryable || attempt === MAX_ATTEMPTS) throw err;

          // 1s, 2s, 4s — enough for a demand spike to clear without
          // stalling a batch for minutes.
          const backoffMs = 1000 * 2 ** (attempt - 1);
          console.warn(
            `[decision-model] ${model.name} attempt ${attempt}/${MAX_ATTEMPTS} failed (${message.slice(0, 80)}); retrying in ${backoffMs}ms`
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      throw lastError;
    },
  };
}

/**
 * Falls through to the next model when one is exhausted or unavailable.
 *
 * Quota on Gemini's free tier is charged per *model* — 20 generate requests
 * per day each — so a single model cannot carry a batch of any size. This is
 * the same failover a production deployment runs for a different reason:
 * when the primary is rate-limited or degraded, serve from the next one
 * rather than dropping the request.
 *
 * The answering model's name is recorded on every decision, so the audit
 * trail always says which one reasoned.
 */
export function withFallback(models: DecisionModel[]): DecisionModel {
  if (models.length === 0) throw new Error("withFallback needs at least one model");

  return {
    name: models.map((m) => m.name).join(" | "),

    async complete(params) {
      let lastError: unknown;

      for (const model of models) {
        try {
          const response = await model.complete(params);
          // Report the model that actually answered, not the chain.
          return { ...response, model: model.name } as ModelResponse;
        } catch (err: any) {
          const message = String(err?.message ?? err);
          // Exhausted or unavailable — try the next one. A 400 is our bug and
          // would fail identically everywhere, so it propagates immediately.
          const shouldFallThrough = /(429|503)|RESOURCE_EXHAUSTED|quota/i.test(message);
          if (!shouldFallThrough) throw err;

          console.warn(
            `[decision-model] ${model.name} unavailable (${message.slice(0, 70)}); trying next`
          );
          lastError = err;
        }
      }

      throw lastError;
    },
  };
}

/**
 * Gemini free-tier quota is per model, so the chain matters more than any
 * single entry. Ordered strongest first; the lite variants are more than
 * capable of a bounded three-way choice.
 */
const GEMINI_FALLBACK_CHAIN = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
];

// --- selection -------------------------------------------------------------

export type ProviderName = "anthropic" | "gemini";

/**
 * Which provider runs is stated, not inferred.
 *
 * The previous rule was "Anthropic wins when both keys are present", and it
 * is the kind of default that costs you a demo. A key in .env.local is a
 * credential, not an instruction to spend it: an Anthropic key on an account
 * with no credit would have silently become the primary, returned a billing
 * error on every event, and — because the decision engine correctly fails
 * closed — escalated the entire batch to humans. The pipeline would have
 * looked cautious rather than broken, which is the worst way to fail.
 *
 * So the provider is read from DECISION_PROVIDER, and when both keys are
 * present without one, we refuse to guess.
 */
export function resolveProviderName(env = process.env): ProviderName {
  const requested = env.DECISION_PROVIDER?.trim().toLowerCase();

  if (requested) {
    if (requested !== "anthropic" && requested !== "gemini") {
      throw new Error(
        `Unknown DECISION_PROVIDER "${requested}". Use "anthropic" or "gemini".`
      );
    }
    const keyVar = requested === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
    if (!env[keyVar]) {
      throw new Error(
        `DECISION_PROVIDER=${requested} but ${keyVar} is not set in .env.local.`
      );
    }
    return requested;
  }

  const available: ProviderName[] = [];
  if (env.ANTHROPIC_API_KEY) available.push("anthropic");
  if (env.GEMINI_API_KEY) available.push("gemini");

  if (available.length === 1) return available[0];

  if (available.length > 1) {
    throw new Error(
      "Both ANTHROPIC_API_KEY and GEMINI_API_KEY are set. Set DECISION_PROVIDER=anthropic or gemini — this is not guessed, because picking the wrong one bills the wrong account and every failed call becomes a human escalation."
    );
  }

  throw new Error(
    "No decision model configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.local — see docs/SETUP.md."
  );
}

export function resolveDecisionModel(env = process.env): DecisionModel {
  const provider = resolveProviderName(env);

  if (provider === "anthropic") {
    return withRetry(createAnthropicModel(env.ANTHROPIC_API_KEY!, env.DECISION_MODEL));
  }

  const chain = env.DECISION_MODEL ? [env.DECISION_MODEL] : GEMINI_FALLBACK_CHAIN;
  return withRetry(
    withFallback(chain.map((m) => createGeminiModel(env.GEMINI_API_KEY!, m)))
  );
}
