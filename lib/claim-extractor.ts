import { z } from "zod";
import type { DecisionModel } from "./decision-model";
import { screenMessage, type Claim, type OfferFacts, type ScreenResult } from "./message-claims";

/**
 * The Dark Pattern Sentinel — extraction.
 *
 * The model's entire job is to read an outbound message and report which
 * factual claims it makes. It is never asked whether a claim is manipulative,
 * whether the message is pushy, or whether it should be sent. Those are
 * judgements, and judgements made by a model are answers that change between
 * Tuesday and Thursday. Whether the merchant's configuration backs a sentence
 * is not a judgement, and `message-claims.ts` decides it deterministically.
 *
 * ## The trap
 *
 * An extractor that fails must not look like a message with nothing to
 * declare.
 *
 * "The model returned nothing" and "this message makes no claims" arrive at
 * the caller as the same empty array unless something keeps them apart, and
 * collapsing them fails open in the worst possible way: every message passes
 * the screen for as long as the model is unreachable, and the screen reports
 * a clean run while doing it. A safety check that switches itself off during
 * an outage and says nothing is worse than no check, because the dashboard
 * still shows green.
 *
 * So extraction returns a result type, never a bare array, and a failure is a
 * hold. This is the same shape as the decision engine turning an unusable
 * model response into a human escalation rather than into an action.
 */

const claimSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("deadline"),
    text: z.string().min(1),
    /**
     * Missing is treated as null, and I had this the other way round.
     *
     * The first version required both fields explicitly, reasoning that a
     * model omitting one was indistinguishable from a response truncated
     * mid-object. That defence was already redundant — truncation has its own
     * detector on `stopReason` — and it was wrong in practice: real Gemini
     * output omits null fields rather than writing them, so every deadline
     * claim it extracted was rejected as the wrong shape and the screen
     * refused to run at all.
     *
     * Rejecting a valid extraction because a model left out a null is the
     * worse failure. A claim with neither time is still checked, and the
     * adjudicator returns `unsupported` for it, which is the safe answer
     * reached honestly.
     */
    hoursFromSend: z.number().finite().nullish().transform((v) => v ?? null),
    absoluteIso: z.string().nullish().transform((v) => v ?? null),
  }),
  z.object({
    type: z.literal("discount"),
    text: z.string().min(1),
    kind: z.enum(["percent", "flat"]),
    value: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("scarcity"),
    text: z.string().min(1),
    unitsRemaining: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("exclusivity"), text: z.string().min(1) }),
  z.object({
    type: z.literal("social_proof"),
    text: z.string().min(1),
    count: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("price_anchor"),
    text: z.string().min(1),
    wasAmountPaise: z.number().int().nonnegative(),
  }),
]);

/**
 * Exported so the screen route validates caller-supplied claims with exactly
 * the rules the extractor applies to the model. Two schemas would drift, and
 * the looser one would become the way in.
 */
export const claimsSchema = z.array(claimSchema);

const responseSchema = z.object({ claims: claimsSchema });

export const EXTRACTION_SYSTEM_PROMPT = `You extract factual claims from a customer message. You do not judge them.

Return JSON: {"claims": [...]}. Each claim carries "text", the exact substring it came from.

Claim types:
- deadline: the message says the offer ends at some time. Report "hoursFromSend" (a number) for relative wording like "in 24 hours" or "by tomorrow", or "absoluteIso" for a stated date. Set the other to null. Do NOT calculate dates yourself.
- discount: a stated reduction. "kind" is "percent" or "flat"; for flat, "value" is in paise.
- scarcity: a stated remaining quantity. "unitsRemaining" is that number.
- exclusivity: the message presents the offer as chosen for this person specifically.
- social_proof: a stated number of other people who bought or are viewing.
- price_anchor: a stated previous or original price. "wasAmountPaise" is in paise.

Rules:
- Report only claims the message actually makes. Do not infer.
- A message with no such claims returns {"claims": []}.
- Never report a claim type not listed above.
- Urgency, politeness and tone are not your concern. Report what is asserted.`;

export type ExtractionResult =
  | { ok: true; claims: Claim[]; model: string }
  | { ok: false; reason: string };

/**
 * Reads an outbound message and reports what it asserts.
 *
 * Every failure path returns `ok: false`, including a model refusal, a
 * truncated response, unparseable JSON and a response that parses but does
 * not match the schema. The last one matters most: a model is perfectly
 * capable of returning well-formed JSON describing a claim type that does not
 * exist, and an unvalidated read of that would reach the adjudicator as a
 * shape it has no branch for.
 */
export async function extractClaims(
  messageText: string,
  model: DecisionModel
): Promise<ExtractionResult> {
  let response;
  try {
    response = await model.complete({
      system: EXTRACTION_SYSTEM_PROMPT,
      user: `Message to analyse:\n\n${messageText}`,
      maxTokens: 800,
    });
  } catch (err: any) {
    return { ok: false, reason: `model_unreachable: ${String(err?.message ?? err).slice(0, 160)}` };
  }

  if (response.stopReason === "refusal") {
    return { ok: false, reason: "model_refused" };
  }

  /**
   * A truncated response is not a short one. The model may have been listing
   * claims when it ran out of tokens, so what did arrive is a prefix — and a
   * prefix of a claim list is exactly the shape that would pass a message by
   * omitting the claim that would have held it.
   */
  if (response.stopReason === "max_tokens") {
    return { ok: false, reason: "model_truncated" };
  }

  if (!response.text) {
    return { ok: false, reason: "model_returned_nothing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return { ok: false, reason: "model_returned_unparseable_json" };
  }

  const validated = responseSchema.safeParse(parsed);
  if (!validated.success) {
    /**
     * The PATH, not just the message.
     *
     * Zod's message for a missing field is the bare word "Required", which in
     * production told me only that something was absent from a response I
     * could not see. `claims.0.text: Required` names the field and the claim
     * index, which is the difference between a diagnosis and a guess — and
     * the guess costs a deploy cycle each time.
     */
    const issue = validated.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "response";
    return {
      ok: false,
      reason: `model_returned_unexpected_shape: ${where}: ${issue?.message ?? "schema mismatch"}`,
    };
  }

  // `validated.data.claims`, not `validated.data`. The first version returned
  // the wrapper object and the cast that silenced it turned a type error into
  // a runtime one — the adjudicator received something with no `.map`.
  const claims: Claim[] = validated.data.claims;
  return { ok: true, claims, model: response.model ?? model.name };
}

export interface OutboundScreen extends ScreenResult {
  /** Null when extraction failed, so a hold can say which half refused. */
  model: string | null;
}

/**
 * The screen a send path calls: extract, then adjudicate.
 *
 * An extraction failure holds the message and says so in the same vocabulary
 * as a contradicted claim, because from the send path's point of view they
 * are the same event — this message does not go out as written. What differs
 * is who a human should go and look at, which is why the reason survives into
 * the summary rather than being flattened to "blocked".
 */
export async function screenOutboundMessage(params: {
  messageText: string;
  facts: OfferFacts;
  nowIso: string;
  model: DecisionModel;
}): Promise<OutboundScreen> {
  const extraction = await extractClaims(params.messageText, params.model);

  if (!extraction.ok) {
    return {
      decision: "hold",
      claims: [],
      blocking: [],
      model: null,
      summary: `Held: the message could not be screened (${extraction.reason}). A screen that cannot run is not a screen that passed.`,
    };
  }

  const result = screenMessage({
    claims: extraction.claims,
    facts: params.facts,
    nowIso: params.nowIso,
  });

  return { ...result, model: extraction.model };
}
