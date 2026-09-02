import { test } from "node:test";
import assert from "node:assert/strict";
import {
  replayEvent,
  replayPolicy,
  comparePolicies,
  estimateRecovery,
  type ReplayEvent,
} from "../lib/replay";
import { DEFAULT_POLICY, type RecoveryPolicy } from "../lib/policy";

/**
 * The Policy Lab's credibility rests on two things: that the exact half is
 * genuinely exact, and that the estimated half never quietly presents itself
 * as measured.
 */

function policyWith(overrides: Partial<RecoveryPolicy>): RecoveryPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

function event(overrides: Partial<ReplayEvent> = {}): ReplayEvent {
  return {
    id: "evt_1",
    amountPaise: 250000, // Rs 2,500
    dnd: false,
    recoveryProbability: 0.35,
    priorAttempts: 0,
    minutesSinceLastContact: null,
    recovered: false,
    recoveredPaise: 0,
    ...overrides,
  };
}

test("consent is refused under every policy", () => {
  // dndRespected is a literal `true` so a relaxed policy cannot even be
  // constructed — but replaying the rule as a no-op would be a quiet way to
  // lose it, so the block is asserted directly.
  for (const cooldown of [0, 240, 10000]) {
    const disposition = replayEvent(
      event({ dnd: true }),
      policyWith({ cooldownMinutes: cooldown, minExpectedValuePaise: -1_000_000 })
    );
    assert.equal(disposition, "blocked_dnd");
  }
});

test("shortening the cooldown releases events the old policy blocked", () => {
  const blocked = event({ id: "evt_cool", minutesSinceLastContact: 60 });

  assert.equal(replayEvent(blocked, policyWith({ cooldownMinutes: 240 })), "blocked_cooldown");
  assert.notEqual(replayEvent(blocked, policyWith({ cooldownMinutes: 30 })), "blocked_cooldown");
});

test("raising the retry ceiling releases events at the old limit", () => {
  const exhausted = event({ id: "evt_retry", priorAttempts: 3 });

  assert.equal(
    replayEvent(exhausted, policyWith({ maxRetryAttempts: 3 })),
    "blocked_retry_ceiling"
  );
  assert.notEqual(
    replayEvent(exhausted, policyWith({ maxRetryAttempts: 5 })),
    "blocked_retry_ceiling"
  );
});

test("raising the expected-value floor declines marginal events", () => {
  // Rs 100 at 10% is Rs 10 expected, against a 70 paise WhatsApp send.
  const marginal = event({ id: "evt_ev", amountPaise: 10000, recoveryProbability: 0.1 });

  assert.notEqual(
    replayEvent(marginal, policyWith({ minExpectedValuePaise: 0 })),
    "declined_negative_ev"
  );
  assert.equal(
    replayEvent(marginal, policyWith({ minExpectedValuePaise: 500000 })),
    "declined_negative_ev"
  );
});

test("gates are applied in the pipeline's order, so the reason is attributable", () => {
  // An event that trips several rules must be attributed to the first one.
  // The Policy Lab is asked "why", and answering with whichever check ran
  // last would misreport a compliance block as an economic decline.
  const multiple = event({
    dnd: true,
    priorAttempts: 99,
    minutesSinceLastContact: 0,
    amountPaise: 1,
    recoveryProbability: 0,
  });

  assert.equal(replayEvent(multiple, DEFAULT_POLICY), "blocked_dnd");

  const noConsentIssue = event({
    priorAttempts: 99,
    minutesSinceLastContact: 0,
    amountPaise: 1,
    recoveryProbability: 0,
  });
  assert.equal(replayEvent(noConsentIssue, DEFAULT_POLICY), "blocked_retry_ceiling");
});

test("a zero holdout puts every eligible event in the treated arm", () => {
  const events = Array.from({ length: 40 }, (_, i) => event({ id: `evt_${i}` }));

  const none = replayPolicy(events, policyWith({ holdoutPercent: 0 }));
  assert.equal(none.totals.holdout_control, 0);
  assert.equal(none.totals.acted, 40);

  const all = replayPolicy(events, policyWith({ holdoutPercent: 100 }));
  assert.equal(all.totals.acted, 0);
  assert.equal(all.totals.holdout_control, 40);
});

test("every event lands in exactly one disposition", () => {
  const events = [
    event({ id: "a", dnd: true }),
    event({ id: "b", priorAttempts: 5 }),
    event({ id: "c", minutesSinceLastContact: 5 }),
    event({ id: "d", amountPaise: 100, recoveryProbability: 0.01 }),
    event({ id: "e" }),
  ];

  const result = replayPolicy(events, DEFAULT_POLICY);
  const counted = Object.values(result.totals).reduce((s, n) => s + n, 0);

  assert.equal(counted, events.length);
  assert.equal(result.outcomes.length, events.length);
});

test("replaying the same policy twice is identical", () => {
  // A counterfactual that drifts between runs is not a counterfactual.
  const events = Array.from({ length: 30 }, (_, i) => event({ id: `evt_${i}` }));
  const first = replayPolicy(events, DEFAULT_POLICY);
  const second = replayPolicy(events, DEFAULT_POLICY);

  assert.deepEqual(first.totals, second.totals);
  assert.deepEqual(first.outcomes, second.outcomes);
});

test("only acted-on events contribute to the at-risk total", () => {
  const result = replayPolicy(
    [
      event({ id: "acted", amountPaise: 100000 }),
      event({ id: "blocked", amountPaise: 900000, dnd: true }),
    ],
    policyWith({ holdoutPercent: 0 })
  );

  assert.equal(result.totals.acted, 1);
  assert.equal(result.actedAtRiskPaise, 100000);
});

test("comparison deltas are candidate minus baseline", () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    event({ id: `evt_${i}`, minutesSinceLastContact: 60 })
  );

  const comparison = comparePolicies(
    events,
    policyWith({ cooldownMinutes: 240 }),
    policyWith({ cooldownMinutes: 30 })
  );

  assert.equal(comparison.baseline.totals.blocked_cooldown, 20);
  assert.equal(comparison.candidate.totals.blocked_cooldown, 0);
  assert.equal(comparison.deltas.blocked_cooldown, -20);
});

test("the recovery estimate is calibrated on measured rates, not an assumed uplift", () => {
  const result = replayPolicy(
    Array.from({ length: 100 }, (_, i) => event({ id: `evt_${i}` })),
    policyWith({ holdoutPercent: 0 })
  );

  const estimate = estimateRecovery(result, {
    treated: { n: 200, converted: 100, recoveredPaise: 1000000 }, // 50%, Rs 100 each
    control: { n: 50, converted: 10, recoveredPaise: 100000 },
  });

  assert.equal(estimate.calibrated, true);
  assert.equal(estimate.treatedConversionRate, 0.5);
  // 100 acted x 50% = 50 conversions, at Rs 10,000 paise per conversion.
  assert.equal(estimate.estimatedRecoveredPaise, 50 * 10000);
});

test("with no treated arm the estimate refuses to invent a rate", () => {
  // Inventing a baseline would make every counterfactual meaningless in a way
  // nothing downstream could detect.
  const result = replayPolicy([event()], policyWith({ holdoutPercent: 0 }));

  const estimate = estimateRecovery(result, {
    treated: { n: 0, converted: 0, recoveredPaise: 0 },
    control: { n: 0, converted: 0, recoveredPaise: 0 },
  });

  assert.equal(estimate.calibrated, false);
  assert.equal(estimate.estimatedRecoveredPaise, 0);
  assert.match(estimate.assumption, /no recovery estimate/i);
});

test("comparison omits the estimate entirely when no observed arms are supplied", () => {
  const comparison = comparePolicies([event()], DEFAULT_POLICY, DEFAULT_POLICY);
  assert.equal(comparison.estimate, null);
});
