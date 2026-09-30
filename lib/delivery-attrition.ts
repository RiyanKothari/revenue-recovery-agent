import { computeLift, type ArmOutcome, type LiftResult } from "./statistics";

/**
 * Measuring lift when some of the treatment never arrived.
 *
 * ## The gap this closes
 *
 * `app/api/webhooks/whatsapp/route.ts` records what Meta later said about
 * each message, and until now nothing read it back. `delivery_state` was a
 * write-only column: the pipeline went to the trouble of authenticating a
 * delivery callback, filing it against the right payment, and appending it to
 * the audit trail, and then every number on the dashboard carried on
 * assuming that an event assigned to the treated arm was an event whose
 * customer had been nudged.
 *
 * Those are different claims. Meta answers 200 and returns a message id for
 * any recipient, then silently drops messages to numbers that are not on a
 * test number's allowed list — so `accepted` is the strongest thing a send
 * can evidence, and a treated arm built from sends is a treated arm
 * containing people who were never treated.
 *
 * ## Why this is not just "drop the failures"
 *
 * The obvious fix — throw failed deliveries out of the treated arm — is a
 * per-protocol analysis, and it trades a known dilution for an unknown bias.
 * Delivery failure is not random. A number that fails is disproportionately a
 * dead number, a wrong number, or someone who never had WhatsApp, and those
 * customers were unlikely to pay whatever anyone sent them. Excluding them
 * removes a slice of the treated arm that was selected, in part, on its
 * propensity to convert — which is the one thing randomisation exists to
 * prevent.
 *
 * So both are reported, and which is which is stated rather than left to the
 * reader:
 *
 * - **Intention to treat** is the causal estimate, on the arms as assigned.
 *   It answers "what did deciding to nudge these customers achieve", which is
 *   the only question a randomised holdout can answer, and it is the headline
 *   for exactly that reason. Undelivered messages drag it toward zero, and
 *   that is not a flaw in the number — the agent really did fail to reach
 *   those people, and a system that quietly excused itself from its own
 *   delivery failures would be grading its own homework.
 * - **Per protocol** is the ceiling: what nudges achieved among customers a
 *   nudge demonstrably reached. Useful for separating "the message does not
 *   work" from "the message does not arrive", which are different problems
 *   with different fixes, and it is not a causal estimate of anything.
 *
 * The gap between the two is the cost of delivery, and it is the number that
 * tells a payments team whether to rewrite the template or fix the phone
 * number collection.
 */

/**
 * What the provider's own callbacks evidence about one event's nudges.
 *
 * `unconfirmed` is the important one: the provider accepted a message and
 * nothing has been heard since. That is the default state of a deployment
 * which has not registered the delivery callback, and it is deliberately not
 * folded into either `delivered` or `failed`, because it is genuine ignorance
 * and both of those are claims.
 *
 * `not_attempted` covers every case where no message reached the provider at
 * all — a guardrail stopped the send, it is still scheduled, the send failed
 * before the request left, or the pipeline ran in dry run. None of those is a
 * message awaiting confirmation, and the distinction is not academic: the
 * seeded production batch ran entirely in dry run, so a rule that read a
 * missing delivery state as `unconfirmed` would have reported 778 messages in
 * flight when not one had ever been sent.
 */
export type DeliveryEvidence = "delivered" | "failed" | "unconfirmed" | "not_attempted";

/**
 * Meta's vocabulary, unmapped — see lib/whatsapp-status.ts for why the
 * provider's own words are stored rather than translated.
 *
 * `read` implies delivered and is listed because a customer who opened the
 * message plainly received it; treating it as anything less would discard the
 * strongest evidence the provider ever sends.
 */
export const DELIVERED_STATES = new Set(["delivered", "read"]);

/**
 * Terminal failure. `sent` and `accepted` are absent on purpose: both mean
 * the message is somewhere inside Meta, which is neither arrival nor failure.
 */
export const FAILED_STATES = new Set(["failed", "undelivered"]);

/**
 * How much of the treated arm must carry provider evidence before a
 * per-protocol arm is worth computing.
 *
 * Below this the per-protocol arm is not a stricter measurement, it is a
 * smaller and differently-selected one. A deployment with no delivery
 * callback registered has evidence for none of its sends, and a per-protocol
 * arm of zero would report a 0% conversion rate — a confident, precise, and
 * entirely fabricated claim that the agent recovers nothing.
 */
export const MIN_EVIDENCE_COVERAGE = 0.5;

/**
 * Ships with every per-protocol figure, for the same reason the Unlearning
 * Verifier's fragility caveat is a required field rather than a docstring: a
 * number whose bias a reader must remember is a number that will eventually
 * be quoted without it.
 */
export const PER_PROTOCOL_CAVEAT =
  "Per protocol is not a causal estimate. Customers whose messages failed are excluded, and delivery failure is not random — an unreachable number is disproportionately a dead one, whose owner was never going to pay. That selects the treated arm partly on its propensity to convert, which is what randomisation exists to prevent, so this figure is expected to run high by an amount nothing here can measure. Intention to treat is the defensible number.";

/**
 * Classifies one event's nudges from the states its send attempts carry.
 *
 * The ordering is the whole content of this function.
 *
 * **One arrival is enough.** An event whose first message failed and whose
 * second was delivered is an event whose customer was treated. Requiring
 * every attempt to have landed would exclude precisely the customers the
 * retry logic exists to reach.
 *
 * **Ignorance outranks failure.** An event with one confirmed failure and one
 * attempt still unconfirmed is `unconfirmed`, not `failed` — the outstanding
 * attempt may well have arrived, and calling it a failure would let a missing
 * callback masquerade as evidence of non-delivery. Only when every attempt
 * has come back terminal can the event be called failed, and that asymmetry
 * is the same fail-toward-ignorance rule the rest of this codebase follows.
 *
 * **An empty state is not an answer.** `action-executor.ts` writes whatever
 * the send returned, and a send that never reached Meta — dry run, or a
 * failure before the request left the process — returns no status at all,
 * leaving the column null. Only a send Meta actually accepted writes
 * `accepted`. So a null is the absence of an attempt rather than an attempt
 * awaiting an answer, and the two must not collapse: the production batch ran
 * entirely in dry run, and treating its nulls as unconfirmed deliveries would
 * have put 778 phantom messages in flight on the dashboard.
 */
export function classifyDelivery(
  states: (string | null | undefined)[]
): DeliveryEvidence {
  const answers = states
    .map((s) => (s ?? "").trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (answers.length === 0) return "not_attempted";

  if (answers.some((s) => DELIVERED_STATES.has(s))) return "delivered";
  if (answers.every((s) => FAILED_STATES.has(s))) return "failed";

  return "unconfirmed";
}

/**
 * Channels whose provider tells us, afterwards, whether the message arrived.
 *
 * Only WhatsApp does, here. This matters because the absence of a delivery
 * state means two opposite things depending on the channel: on WhatsApp it is
 * a message whose fate is unknown, and on email or a human escalation it is a
 * channel that was never going to report one. Folding the second into
 * `unconfirmed` would fill the attrition counts with rows that are not
 * missing anything.
 */
export const PROVIDER_CONFIRMED_CHANNELS = new Set(["whatsapp"]);

/**
 * Groups the provider's answers by the payment they chased.
 *
 * One event can carry several attempts, and the classification above needs
 * all of them together rather than one at a time.
 */
export function collectDeliveryStates(
  actions: { revenue_event_id: string; channel: string; delivery_state: string | null }[]
): Map<string, (string | null)[]> {
  const byEvent = new Map<string, (string | null)[]>();

  for (const action of actions) {
    if (!PROVIDER_CONFIRMED_CHANNELS.has(action.channel)) continue;
    const states = byEvent.get(action.revenue_event_id);
    if (states) states.push(action.delivery_state);
    else byEvent.set(action.revenue_event_id, [action.delivery_state]);
  }

  return byEvent;
}

export interface AttritionCounts {
  delivered: number;
  failed: number;
  unconfirmed: number;
  /**
   * Assigned to the treated arm and never actually messaged — a guardrail
   * stopped it, the send is still scheduled, the send failed before leaving
   * the process, or the run was a dry run. Distinct from a failure, because
   * the provider was never involved, and distinct from unconfirmed, because
   * there is no message out there to confirm.
   */
  notAttempted: number;
}

export interface MeasuredArms {
  treated: ArmOutcome;
  control: ArmOutcome;
  lift: LiftResult;
}

/** Why no per-protocol arm was computed, when none was. */
export type PerProtocolStatus = "computed" | "unevidenced";

export interface DeliveryAdjustedLift {
  /** The causal estimate, on the arms as randomised. Always the headline. */
  intentionToTreat: MeasuredArms;
  /**
   * The ceiling, among customers a message demonstrably reached. Null when
   * the provider has not said enough for it to mean anything.
   */
  perProtocol: MeasuredArms | null;
  perProtocolStatus: PerProtocolStatus;
  attrition: AttritionCounts;
  /**
   * The share of the treated arm the provider has given a terminal answer
   * about. This is a measure of the audit's completeness, not the agent's.
   */
  evidenceCoverage: number;
  /**
   * The cost of delivery in percentage points: how much better nudges did
   * among customers they reached than among customers they were sent to.
   * Null whenever there is no per-protocol arm to compare against.
   */
  deliveryCostPp: number | null;
  /** How to read the pair above, in the deployment's actual current state. */
  reading: string;
  /** Always present. See PER_PROTOCOL_CAVEAT. */
  caveat: string;
}

function emptyArm(): ArmOutcome {
  return { n: 0, converted: 0, recoveredPaise: 0 };
}

/**
 * Measures lift twice: once on the arms as assigned, once on the treatment
 * that provably arrived.
 *
 * `deliveryStates` is keyed by revenue event and holds the states of that
 * event's *message-bearing* send attempts — the caller decides which channels
 * carry a message, because an email or a human escalation has no provider
 * callback and its absence is not evidence of anything. An event missing from
 * the map was never messaged.
 */
export function measureWithDelivery(params: {
  assignments: { revenueEventId: string; arm: string }[];
  deliveryStates: Map<string, (string | null | undefined)[]>;
  /** Recovered amount in paise, keyed by event. Presence means converted. */
  recoveredPaiseByEvent: Map<string, number>;
}): DeliveryAdjustedLift {
  const itt = { treated: emptyArm(), control: emptyArm() };
  const perProtocol = { treated: emptyArm(), control: emptyArm() };

  const attrition: AttritionCounts = {
    delivered: 0,
    failed: 0,
    unconfirmed: 0,
    notAttempted: 0,
  };

  for (const assignment of params.assignments) {
    // Anything not explicitly control is treated — the same widening the
    // dashboard applies, so the two cannot disagree about the denominator.
    const arm = assignment.arm === "control" ? "control" : "treated";

    const recovered = params.recoveredPaiseByEvent.get(assignment.revenueEventId);
    const converted = recovered !== undefined;

    itt[arm].n += 1;
    if (converted) {
      itt[arm].converted += 1;
      itt[arm].recoveredPaise += recovered;
    }

    if (arm === "control") {
      /**
       * The control arm passes through untouched.
       *
       * There is nothing to confirm: a control event was deliberately never
       * messaged, so it has no delivery evidence and needs none. Filtering it
       * by the same rule as the treated arm would empty it and leave the
       * per-protocol comparison with no baseline at all.
       */
      perProtocol.control.n += 1;
      if (converted) {
        perProtocol.control.converted += 1;
        perProtocol.control.recoveredPaise += recovered;
      }
      continue;
    }

    const evidence = classifyDelivery(
      params.deliveryStates.get(assignment.revenueEventId) ?? []
    );

    if (evidence === "delivered") attrition.delivered += 1;
    else if (evidence === "failed") attrition.failed += 1;
    else if (evidence === "unconfirmed") attrition.unconfirmed += 1;
    else attrition.notAttempted += 1;

    if (evidence === "delivered") {
      perProtocol.treated.n += 1;
      if (converted) {
        perProtocol.treated.converted += 1;
        perProtocol.treated.recoveredPaise += recovered;
      }
    }
  }

  const ittLift = computeLift(itt.treated, itt.control);

  /**
   * Coverage counts only the terminal answers. An unconfirmed send is not
   * partial evidence — it is the absence of evidence, and counting it would
   * make a deployment with no callback registered look fully audited.
   */
  const evidenceCoverage = itt.treated.n
    ? (attrition.delivered + attrition.failed) / itt.treated.n
    : 0;

  const base = {
    intentionToTreat: { ...itt, lift: ittLift },
    attrition,
    evidenceCoverage,
    caveat: PER_PROTOCOL_CAVEAT,
  };

  if (evidenceCoverage < MIN_EVIDENCE_COVERAGE) {
    /**
     * Three different states, and saying "unconfirmed" for all of them would
     * be the same overstatement this module exists to stop. A batch that
     * never sent anything has no messages awaiting an answer.
     */
    const why =
      attrition.delivered + attrition.failed > 0
        ? `The provider has given a terminal answer for ${Math.round(evidenceCoverage * 100)}% of them, below the ${Math.round(MIN_EVIDENCE_COVERAGE * 100)}% needed for the restricted arm to be a stricter measurement rather than a smaller and differently-selected one.`
        : attrition.unconfirmed > 0
          ? `${attrition.unconfirmed} messages were accepted by the provider and nothing has been heard about any of them since, which is what a deployment with no delivery callback registered looks like.`
          : "No message reached the provider at all — every send here was withheld by a guardrail, is still scheduled, or was logged rather than sent.";

    return {
      ...base,
      perProtocol: null,
      perProtocolStatus: "unevidenced",
      deliveryCostPp: null,
      reading: `Lift is reported on the arms as assigned, which is the causal estimate. It cannot yet be separated into "the nudge does not work" and "the nudge does not arrive". ${why} Note that the assigned-arm figure already absorbs every undelivered message, so it is a floor.`,
    };
  }

  const ppLift = computeLift(perProtocol.treated, perProtocol.control);

  return {
    ...base,
    perProtocol: { ...perProtocol, lift: ppLift },
    perProtocolStatus: "computed",
    deliveryCostPp: ppLift.absoluteLiftPp - ittLift.absoluteLiftPp,
    reading: `Deciding to nudge moved recovery by ${ittLift.absoluteLiftPp.toFixed(1)}pp. Among the ${perProtocol.treated.n} customers a nudge demonstrably reached it moved ${ppLift.absoluteLiftPp.toFixed(1)}pp. The ${(ppLift.absoluteLiftPp - ittLift.absoluteLiftPp).toFixed(1)}pp between them is what undelivered messages cost — a delivery problem, not a messaging one. The first figure is the one the agent can claim.`,
  };
}
