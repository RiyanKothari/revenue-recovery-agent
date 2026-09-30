import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_EVIDENCE_COVERAGE,
  PER_PROTOCOL_CAVEAT,
  classifyDelivery,
  collectDeliveryStates,
  measureWithDelivery,
} from "../lib/delivery-attrition";

/**
 * Lift when some of the treatment never arrived.
 *
 * The assertions that matter are about the two ways this could quietly lie:
 * by letting a missing delivery callback pass as evidence of non-delivery,
 * and by presenting the flattering per-protocol number as though a holdout
 * had established it.
 */

// --- classifying the provider's answers

test("one message arriving is enough, however the other attempts went", () => {
  // The retry logic exists to reach people whose first message failed. An
  // event whose second attempt landed is an event whose customer was treated.
  assert.equal(classifyDelivery(["failed", "delivered"]), "delivered");
  assert.equal(classifyDelivery(["read"]), "delivered");
  assert.equal(classifyDelivery(["accepted", "read"]), "delivered");
});

test("ignorance outranks failure", () => {
  /**
   * The asymmetry the whole module turns on. One confirmed failure plus one
   * attempt still outstanding is not a failed delivery — the outstanding
   * message may well have arrived, and calling it failed would let a missing
   * callback masquerade as evidence.
   */
  assert.equal(classifyDelivery(["failed", "accepted"]), "unconfirmed");
  assert.equal(classifyDelivery(["failed", "sent"]), "unconfirmed");
  assert.equal(classifyDelivery(["failed"]), "failed");
  assert.equal(classifyDelivery(["failed", "undelivered"]), "failed");
});

test("a send the provider accepted is unconfirmed, and no send is neither", () => {
  // `accepted` is what a live send returns, so an unregistered callback leaves
  // the whole batch here. That is ignorance, not a delivery failure.
  assert.equal(classifyDelivery(["accepted"]), "unconfirmed");
  assert.equal(classifyDelivery(["sent"]), "unconfirmed");
  assert.equal(classifyDelivery([]), "not_attempted");
});

test("a message that never reached the provider is not awaiting an answer", () => {
  /**
   * The case real data caught. `action-executor.ts` records whatever the send
   * returned, and a dry run — or a failure before the request left the
   * process — returns no status, so the column is null. Only a send Meta
   * accepted writes `accepted`.
   *
   * The seeded production batch is 778 WhatsApp actions, every one of them a
   * dry run with a null state. Reading those as unconfirmed would have put
   * 778 messages in flight awaiting confirmation when not one was ever sent,
   * which is a stronger claim than the delivered/failed split it sits next to.
   */
  assert.equal(classifyDelivery([null]), "not_attempted");
  assert.equal(classifyDelivery([null, undefined]), "not_attempted");
  assert.equal(classifyDelivery([""]), "not_attempted");

  // One real attempt among them is still a real attempt.
  assert.equal(classifyDelivery([null, "accepted"]), "unconfirmed");
  assert.equal(classifyDelivery([null, "delivered"]), "delivered");
  assert.equal(classifyDelivery([null, "failed"]), "failed");
});

test("the provider's casing and padding do not change the verdict", () => {
  assert.equal(classifyDelivery([" Delivered "]), "delivered");
  assert.equal(classifyDelivery(["FAILED"]), "failed");
});

// --- grouping the rows the database returns

test("only channels with a provider that calls back are collected", () => {
  /**
   * An email with no delivery state is not an unconfirmed delivery, it is a
   * channel that was never going to report one. Counting it as unconfirmed
   * would fill the attrition breakdown with rows that are not missing
   * anything, and drag the evidence coverage down for a reason that has
   * nothing to do with WhatsApp.
   */
  const collected = collectDeliveryStates([
    { revenue_event_id: "e1", channel: "whatsapp", delivery_state: "delivered" },
    { revenue_event_id: "e1", channel: "email", delivery_state: null },
    { revenue_event_id: "e2", channel: "human_escalation", delivery_state: null },
  ]);

  assert.deepEqual(collected.get("e1"), ["delivered"]);
  assert.equal(collected.has("e2"), false, "an escalation is not an unconfirmed message");
});

test("several attempts on one payment are grouped, not overwritten", () => {
  // The classification needs every attempt together: one failure followed by
  // one arrival is a customer who was reached.
  const collected = collectDeliveryStates([
    { revenue_event_id: "e1", channel: "whatsapp", delivery_state: "failed" },
    { revenue_event_id: "e1", channel: "whatsapp", delivery_state: "delivered" },
  ]);

  assert.equal(collected.get("e1")!.length, 2);
  assert.equal(classifyDelivery(collected.get("e1")!), "delivered");
});

// --- the state this deployment is actually in

test("with no callback registered, there is no per-protocol arm to report", () => {
  /**
   * The live deployment's own case: every send returns `accepted` and nothing
   * comes back. A per-protocol arm here would have n=0 and report a 0%
   * conversion rate — a precise, confident claim that the agent recovers
   * nothing, assembled entirely out of missing data.
   */
  const measured = measureWithDelivery(
    scenario({
      treated: Array.from({ length: 200 }, (_, i) => ({
        states: ["accepted"],
        converted: i < 60,
      })),
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.perProtocolStatus, "unevidenced");
  assert.equal(measured.perProtocol, null);
  assert.equal(measured.deliveryCostPp, null);
  assert.equal(measured.evidenceCoverage, 0);
  assert.equal(measured.attrition.unconfirmed, 200);

  // The assigned-arm number still works, and says what it is.
  assert.ok(Math.abs(measured.intentionToTreat.lift.absoluteLiftPp - 10) < 0.01);
  assert.match(measured.reading, /no delivery callback registered/);
  assert.match(measured.reading, /it is a floor/);
});

test("partial evidence is refused rather than reported on a thin slice", () => {
  // A quarter of the arm confirmed is not a stricter measurement, it is a
  // smaller and differently-selected one.
  const measured = measureWithDelivery(
    scenario({
      treated: Array.from({ length: 200 }, (_, i) => ({
        states: [i < 50 ? "delivered" : "accepted"],
        converted: i < 60,
      })),
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.perProtocolStatus, "unevidenced");
  assert.ok(measured.evidenceCoverage < MIN_EVIDENCE_COVERAGE);
  assert.match(measured.reading, /25% of them/);
});

// --- the measurement itself

test("undelivered messages dilute the assigned-arm lift, and the gap is named", () => {
  /**
   * The point of the module. Half the treated arm never received anything,
   * and those customers converted at the control rate because nothing
   * reached them. Deciding to nudge moved 10pp; nudges that arrived moved
   * 20pp. The difference is a delivery problem, not a messaging one.
   */
  const measured = measureWithDelivery(
    scenario({
      treated: [
        ...cohort(100, "delivered", 40),
        ...cohort(100, "failed", 20),
      ],
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.perProtocolStatus, "computed");
  assert.equal(measured.evidenceCoverage, 1);

  assert.ok(Math.abs(measured.intentionToTreat.lift.absoluteLiftPp - 10) < 0.01);
  assert.ok(Math.abs(measured.perProtocol!.lift.absoluteLiftPp - 20) < 0.01);
  assert.ok(Math.abs(measured.deliveryCostPp! - 10) < 0.01);

  assert.match(measured.reading, /The first figure is the one the agent can claim/);
});

test("the control arm is never filtered by delivery evidence", () => {
  /**
   * Structural. A control event was deliberately never messaged, so it has no
   * delivery evidence and needs none — applying the treated arm's filter to
   * it would empty the baseline and leave the per-protocol comparison with
   * nothing to compare against.
   */
  const measured = measureWithDelivery(
    scenario({
      treated: cohort(100, "delivered", 40),
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.perProtocol!.control.n, 200);
  assert.equal(measured.perProtocol!.control.converted, 40);
  assert.equal(measured.intentionToTreat.control.n, 200);
});

test("an unconfirmed send is excluded from the per-protocol arm even when coverage is high", () => {
  // Coverage is about whether the arm is worth computing. Membership is about
  // whether this particular customer was provably reached, and an unanswered
  // callback does not prove it.
  const measured = measureWithDelivery(
    scenario({
      treated: [
        ...cohort(150, "delivered", 60),
        ...cohort(50, "accepted", 10),
      ],
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.perProtocolStatus, "computed");
  assert.equal(measured.perProtocol!.treated.n, 150);
  assert.equal(measured.perProtocol!.treated.converted, 60);
  assert.equal(measured.attrition.unconfirmed, 50);
  // The assigned arm keeps all 200, including the 50 nobody can vouch for.
  assert.equal(measured.intentionToTreat.treated.n, 200);
});

test("a treated event that was never messaged is attrition, not a failure", () => {
  // A guardrail stopped it, or the send is still scheduled. Nothing went
  // wrong with the provider, and recording it as a delivery failure would
  // blame Meta for our own hold.
  const measured = measureWithDelivery(
    scenario({
      treated: [...cohort(100, "delivered", 40), ...cohort(100, null, 20)],
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.attrition.notAttempted, 100);
  assert.equal(measured.attrition.failed, 0);
  // Still counted in the assigned arm: the decision to treat was made.
  assert.equal(measured.intentionToTreat.treated.n, 200);
});

test("recovered money follows the same split as the conversions", () => {
  const measured = measureWithDelivery(
    scenario({
      treated: [...cohort(100, "delivered", 40), ...cohort(100, "failed", 20)],
      control: 200,
      controlConverted: 40,
      paisePerConversion: 50_000,
    })
  );

  assert.equal(measured.intentionToTreat.treated.recoveredPaise, 60 * 50_000);
  assert.equal(measured.perProtocol!.treated.recoveredPaise, 40 * 50_000);
});

// --- the caveat is structural

test("every result carries the per-protocol caveat, including the ones with no per-protocol arm", () => {
  /**
   * Same discipline as the Unlearning Verifier's fragility caveat. A number
   * whose bias the reader has to remember is a number that will eventually be
   * quoted without it, and the caveat matters most on the day the arm appears.
   */
  for (const states of [["accepted"], ["delivered"]]) {
    const measured = measureWithDelivery(
      scenario({
        treated: Array.from({ length: 200 }, (_, i) => ({
          states,
          converted: i < 60,
        })),
        control: 200,
        controlConverted: 40,
      })
    );

    assert.equal(measured.caveat, PER_PROTOCOL_CAVEAT);
    assert.match(measured.caveat, /not a causal estimate/);
    assert.match(measured.caveat, /expected to run high/);
  }
});

test("a dry-run batch reports nothing sent, not everything unconfirmed", () => {
  /**
   * The live deployment's actual shape, end to end: every send is a dry-run
   * log with no provider status. The honest reading is that no message was
   * attempted, and the assigned-arm lift is still the number to quote.
   */
  const measured = measureWithDelivery(
    scenario({
      treated: Array.from({ length: 200 }, (_, i) => ({
        states: [null],
        converted: i < 60,
      })),
      control: 200,
      controlConverted: 40,
    })
  );

  assert.equal(measured.attrition.notAttempted, 200);
  assert.equal(measured.attrition.unconfirmed, 0);
  assert.equal(measured.perProtocolStatus, "unevidenced");
  assert.ok(Math.abs(measured.intentionToTreat.lift.absoluteLiftPp - 10) < 0.01);
});

test("an empty batch reports nothing rather than dividing by zero", () => {
  const measured = measureWithDelivery({
    assignments: [],
    deliveryStates: new Map(),
    recoveredPaiseByEvent: new Map(),
  });

  assert.equal(measured.evidenceCoverage, 0);
  assert.equal(measured.perProtocol, null);
  assert.equal(measured.intentionToTreat.treated.n, 0);
});

// --- fixtures

/** `count` treated events all sharing one delivery state, `converted` of which paid. */
function cohort(
  count: number,
  state: string | null,
  converted: number
): { states: (string | null)[]; converted: boolean }[] {
  return Array.from({ length: count }, (_, i) => ({
    states: state === null ? [] : [state],
    converted: i < converted,
  }));
}

function scenario(spec: {
  treated: { states: (string | null)[]; converted: boolean }[];
  control: number;
  controlConverted: number;
  paisePerConversion?: number;
}) {
  const paise = spec.paisePerConversion ?? 10_000;
  const assignments: { revenueEventId: string; arm: string }[] = [];
  const deliveryStates = new Map<string, (string | null)[]>();
  const recoveredPaiseByEvent = new Map<string, number>();

  spec.treated.forEach((event, i) => {
    const id = `t_${i}`;
    assignments.push({ revenueEventId: id, arm: "treated" });
    if (event.states.length > 0) deliveryStates.set(id, event.states);
    if (event.converted) recoveredPaiseByEvent.set(id, paise);
  });

  for (let i = 0; i < spec.control; i += 1) {
    const id = `c_${i}`;
    assignments.push({ revenueEventId: id, arm: "control" });
    if (i < spec.controlConverted) recoveredPaiseByEvent.set(id, paise);
  }

  return { assignments, deliveryStates, recoveredPaiseByEvent };
}
