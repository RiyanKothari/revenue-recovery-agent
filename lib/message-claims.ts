/**
 * The Dark Pattern Sentinel — adjudication.
 *
 * ## The insight
 *
 * Urgency is only a dark pattern when it is false.
 *
 * "This offer expires in 24 hours" is not manipulation if the offer really
 * expires in 24 hours; it is useful information, and a system that flagged it
 * would be flagging honest commerce. The same sentence sent against a coupon
 * with no expiry at all is a fabricated deadline manufactured to stop someone
 * thinking. The words are identical. Only the *record* tells them apart.
 *
 * That is why every published dark-pattern detector that scores copy for
 * "manipulative language" is solving the wrong problem. It cannot see the
 * merchant's configuration, so it can only guess at tone, which means it
 * flags honest urgency and misses the dishonest kind whenever the dishonest
 * kind is politely worded.
 *
 * ## The split
 *
 * A model extracts claims. Deterministic code adjudicates them. Nothing here
 * asks a model whether something is manipulative, because that is a judgement
 * it would make differently on Tuesday, and because the answer is not a
 * matter of opinion — either the merchant's offer config backs the sentence
 * or it does not.
 *
 * This is the same division the decision engine already runs on: the model
 * chooses among approved actions and deterministic guardrails hold the veto.
 * Extraction is the fallible part and it is confined to the step where being
 * wrong is recoverable, because an extraction that invents a claim causes a
 * message to be held for review, while an extraction that misses one is
 * caught by the fact that unverifiable claims are refused by default.
 *
 * ## The rule
 *
 * **Every factual claim in an outbound message must be backed by the
 * merchant's configuration, or the message does not go.**
 *
 * One rule, fail-closed, and the third verdict is what makes it work. A claim
 * with no ground truth to check against is `unsupported`, not `supported` —
 * "we could not check this" and "this is true" are completely different
 * statements, and a screen that showed them alike would pass every claim
 * about anything the system happens not to model.
 *
 * Nothing here reads the clock or the database. `now` and the facts are both
 * arguments.
 */

export type ClaimType =
  | "deadline"
  | "discount"
  | "scarcity"
  | "exclusivity"
  | "social_proof"
  | "price_anchor";

/**
 * A claim as the extractor found it, carrying the exact words it came from.
 *
 * `text` is not decoration. A reviewer looking at a held message needs to see
 * the sentence that caused the hold, and a verdict that cannot be traced back
 * to the words it judged is an accusation without evidence.
 */
interface BaseClaim {
  type: ClaimType;
  text: string;
}

export type Claim =
  | (BaseClaim & {
      type: "deadline";
      /**
       * Kept as the message states it, relative or absolute, and resolved
       * against `now` here rather than by the extractor.
       *
       * A model asked to turn "by tomorrow evening" into a timestamp is being
       * asked to do date arithmetic against a clock it cannot read, which is
       * two known weaknesses at once. It reports the shape of the claim; this
       * module does the arithmetic.
       */
      hoursFromSend: number | null;
      absoluteIso: string | null;
    })
  | (BaseClaim & { type: "discount"; kind: "percent" | "flat"; value: number })
  | (BaseClaim & { type: "scarcity"; unitsRemaining: number })
  | (BaseClaim & { type: "exclusivity" })
  | (BaseClaim & { type: "social_proof"; count: number })
  | (BaseClaim & { type: "price_anchor"; wasAmountPaise: number });

/**
 * The merchant's configuration: the ground truth a claim is checked against.
 *
 * Every field is optional, and that is the point. An absent field means this
 * system has no record to check the claim against, which produces
 * `unsupported` rather than a pass. Modelling it as optional rather than
 * defaulting to a permissive value keeps "we do not know" from silently
 * becoming "it is fine".
 */
export interface OfferFacts {
  offerExpiresAtIso?: string | null;
  discount?: { kind: "percent" | "flat"; value: number } | null;
  unitsRemaining?: number | null;
  /**
   * Whether this offer really is for this customer alone.
   *
   * `universal` against a message saying "a special price just for you" is
   * the cleanest dark pattern in the set: nothing about the words is
   * aggressive, and the claim is simply untrue.
   */
  offerScope?: "personalised" | "universal" | null;
  recentPurchaseCount?: number | null;
  previousPricePaise?: number | null;
}

export type Verdict = "supported" | "contradicted" | "unsupported";

export interface AdjudicatedClaim {
  claim: Claim;
  verdict: Verdict;
  /** Plain language, written for the audit trail and for a human reviewer. */
  reason: string;
}

/**
 * How far a stated deadline may drift from the real one before it is false.
 *
 * An hour, because "expires tomorrow" against an expiry at 23:30 tomorrow is
 * honest rounding, not manipulation, and a screen that cannot tell rounding
 * from a fabricated deadline will be switched off within a week for crying
 * wolf. A detector nobody leaves running detects nothing.
 */
export const DEADLINE_TOLERANCE_MS = 60 * 60 * 1000;

function supported(claim: Claim, reason: string): AdjudicatedClaim {
  return { claim, verdict: "supported", reason };
}

function contradicted(claim: Claim, reason: string): AdjudicatedClaim {
  return { claim, verdict: "contradicted", reason };
}

function unsupported(claim: Claim, reason: string): AdjudicatedClaim {
  return { claim, verdict: "unsupported", reason };
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

/**
 * One claim against the record.
 *
 * Every branch answers the same question: does the merchant's configuration
 * say this? Not "is this aggressive", not "would a reasonable customer feel
 * pressured" — those are judgements, and judgements are what the model is
 * deliberately not being asked for.
 */
export function adjudicateClaim(
  claim: Claim,
  facts: OfferFacts,
  nowIso: string
): AdjudicatedClaim {
  switch (claim.type) {
    case "deadline": {
      if (!facts.offerExpiresAtIso) {
        /**
         * The canonical case, and the reason this agent exists. A message
         * saying the offer ends tonight, against a coupon with no expiry
         * configured at all, is a deadline that exists only in the sentence.
         */
        return unsupported(
          claim,
          "The message states a deadline, but no expiry is configured for this offer. An urgency claim with no expiry behind it is a deadline that exists only in the message."
        );
      }

      const claimedAt =
        claim.absoluteIso !== null
          ? Date.parse(claim.absoluteIso)
          : claim.hoursFromSend !== null
            ? Date.parse(nowIso) + claim.hoursFromSend * 60 * 60 * 1000
            : NaN;

      if (Number.isNaN(claimedAt)) {
        return unsupported(
          claim,
          "The message states a deadline that could not be resolved to a time, so it cannot be checked against the configured expiry."
        );
      }

      const realAt = Date.parse(facts.offerExpiresAtIso);
      const drift = claimedAt - realAt;

      if (Math.abs(drift) <= DEADLINE_TOLERANCE_MS) {
        return supported(claim, "The stated deadline matches the configured expiry.");
      }

      /**
       * Both directions are false, and the harms are different enough that
       * the reason has to say which. Earlier than the truth manufactures
       * pressure to decide now. Later than the truth is a promise the offer
       * cannot keep, and the customer discovers it at the checkout.
       */
      const hours = Math.round(Math.abs(drift) / (60 * 60 * 1000));
      return contradicted(
        claim,
        drift < 0
          ? `The message brings the deadline forward by about ${hours}h against the configured expiry, which manufactures urgency that the offer does not have.`
          : `The message promises about ${hours}h longer than the configured expiry, which the offer cannot honour.`
      );
    }

    case "discount": {
      if (!facts.discount) {
        return unsupported(
          claim,
          "The message states a discount, but no discount is configured for this offer."
        );
      }

      if (facts.discount.kind !== claim.kind || facts.discount.value !== claim.value) {
        const stated =
          claim.kind === "percent" ? `${claim.value}%` : rupees(claim.value);
        const real =
          facts.discount.kind === "percent"
            ? `${facts.discount.value}%`
            : rupees(facts.discount.value);
        return contradicted(
          claim,
          `The message states ${stated} off, but the configured discount is ${real}.`
        );
      }

      return supported(claim, "The stated discount matches the configured one.");
    }

    case "scarcity": {
      if (facts.unitsRemaining === null || facts.unitsRemaining === undefined) {
        return unsupported(
          claim,
          "The message states limited stock, but no remaining quantity is recorded for this offer."
        );
      }

      /**
       * Understating stock is the manipulation; overstating it is not.
       *
       * "Only 3 left" against 500 in the warehouse is a fabricated queue.
       * "Only 3 left" against 2 actually remaining is a message that has
       * fallen slightly behind real stock, which is an accuracy problem and
       * not a pressure tactic — and blocking it would mean the screen fires
       * on exactly the merchants whose stock moves fastest.
       */
      if (claim.unitsRemaining < facts.unitsRemaining) {
        return contradicted(
          claim,
          `The message says ${claim.unitsRemaining} remaining, but ${facts.unitsRemaining} are in stock. Understating supply manufactures a queue that does not exist.`
        );
      }

      return supported(
        claim,
        "The stated quantity does not understate what is actually in stock."
      );
    }

    case "exclusivity": {
      if (!facts.offerScope) {
        return unsupported(
          claim,
          "The message presents the offer as personal, but this offer's scope is not recorded."
        );
      }

      if (facts.offerScope === "universal") {
        return contradicted(
          claim,
          "The message presents the offer as chosen for this customer, but the same offer is available to everyone."
        );
      }

      return supported(claim, "The offer really is specific to this customer.");
    }

    case "social_proof": {
      if (facts.recentPurchaseCount === null || facts.recentPurchaseCount === undefined) {
        return unsupported(
          claim,
          "The message cites how many others bought, but no such count is recorded."
        );
      }

      // Overstating invents a crowd. Understating is merely conservative.
      if (claim.count > facts.recentPurchaseCount) {
        return contradicted(
          claim,
          `The message cites ${claim.count} recent buyers, but ${facts.recentPurchaseCount} are recorded.`
        );
      }

      return supported(claim, "The cited count does not exceed what is recorded.");
    }

    case "price_anchor": {
      if (facts.previousPricePaise === null || facts.previousPricePaise === undefined) {
        /**
         * The fake anchor: a "was" price the item was never actually sold at,
         * printed to make the current price look like a saving. Unverifiable
         * by construction unless the price history is on record, which is
         * exactly why it has to fail closed rather than pass.
         */
        return unsupported(
          claim,
          "The message cites a previous price, but no price history is recorded to support it."
        );
      }

      if (claim.wasAmountPaise !== facts.previousPricePaise) {
        return contradicted(
          claim,
          `The message cites a previous price of ${rupees(claim.wasAmountPaise)}, but the recorded previous price is ${rupees(facts.previousPricePaise)}.`
        );
      }

      return supported(claim, "The cited previous price matches the recorded one.");
    }
  }
}

export interface ScreenResult {
  /** `hold` means the message does not go out as written. */
  decision: "send" | "hold";
  claims: AdjudicatedClaim[];
  /** The claims that caused a hold, in the order they appeared. */
  blocking: AdjudicatedClaim[];
  /** One line for the audit trail. */
  summary: string;
}

/**
 * The whole message.
 *
 * A message with no factual claims sends. That is not a loophole, it is the
 * correct answer: "your payment didn't go through, here's a link to try
 * again" asserts nothing about an offer, and a screen that held it would be
 * blocking the plainest and most honest message in the system.
 *
 * Everything else must be `supported`. Holding on `unsupported` as well as
 * `contradicted` is the deliberately strict choice, and it is the one that
 * makes the rule enforceable: if unverifiable claims passed, every dark
 * pattern would simply be one the system has no ground truth for, and the
 * detector would grade itself on the subset it already handles.
 */
export function screenMessage(params: {
  claims: Claim[];
  facts: OfferFacts;
  nowIso: string;
}): ScreenResult {
  const claims = params.claims.map((claim) =>
    adjudicateClaim(claim, params.facts, params.nowIso)
  );

  const blocking = claims.filter((c) => c.verdict !== "supported");

  if (blocking.length === 0) {
    return {
      decision: "send",
      claims,
      blocking,
      summary:
        claims.length === 0
          ? "No factual claims in this message."
          : `All ${claims.length} claim${claims.length === 1 ? "" : "s"} are backed by the offer configuration.`,
    };
  }

  const contradictions = blocking.filter((c) => c.verdict === "contradicted").length;
  const unverifiable = blocking.length - contradictions;

  const parts: string[] = [];
  if (contradictions > 0) {
    parts.push(`${contradictions} contradicted by the offer configuration`);
  }
  if (unverifiable > 0) {
    parts.push(`${unverifiable} with nothing on record to support ${unverifiable === 1 ? "it" : "them"}`);
  }

  return {
    decision: "hold",
    claims,
    blocking,
    summary: `Held: ${parts.join(", ")}.`,
  };
}
