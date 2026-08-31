import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyConformance, type ConformanceInput } from "../lib/invariants";
import {
  estimateComplianceCost,
  categorise,
  type BlockedEvent,
} from "../lib/compliance-cost";
import { DEFAULT_POLICY } from "../lib/policy";

/**
 * A verifier that always passes proves nothing. Most of these tests plant a
 * specific violation and assert it is caught — a checker is only worth
 * running if it can fail.
 */

function baseInput(overrides: Partial<ConformanceInput> = {}): ConformanceInput {
  return {
    events: [
      { id: "evt_1", customer_id: "cust_1", amount_paise: 100000, root_cause: "bank_timeout" },
      { id: "evt_2", customer_id: "cust_2", amount_paise: 50000, root_cause: "card_declined" },
    ],
    decisions: [
      {
        id: "dec_1",
        revenue_event_id: "evt_1",
        chosen_action: "send_retry_link_whatsapp",
        rationale: "Transient failure, first attempt.",
      },
      {
        id: "dec_2",
        revenue_event_id: "evt_2",
        chosen_action: "escalate_human",
        rationale: "Needs customer action.",
      },
    ],
    actions: [
      {
        agent_decision_id: "dec_1",
        channel: "whatsapp",
        status: "sent",
        attempt_number: 1,
        executed_at: "2026-09-01T10:00:00.000Z",
      },
      {
        agent_decision_id: "dec_2",
        channel: "human_escalation",
        status: "sent",
        attempt_number: 1,
        executed_at: "2026-09-01T10:05:00.000Z",
      },
    ],
    consent: [{ customer_id: "cust_3", dnd: true }],
    assignments: [
      { revenue_event_id: "evt_1", arm: "treated" },
      { revenue_event_id: "evt_2", arm: "treated" },
    ],
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

function violationsFor(report: ReturnType<typeof verifyConformance>, id: string) {
  return report.results.find((r) => r.id === id)?.violations ?? [];
}

test("a clean batch passes every invariant", () => {
  const report = verifyConformance(baseInput());

  assert.equal(report.passed, true);
  assert.equal(report.totalViolations, 0);
  assert.equal(report.results.length, 7);
});

test("catches a message sent to a customer with DND set", () => {
  const input = baseInput({ consent: [{ customer_id: "cust_1", dnd: true }] });
  const report = verifyConformance(input);

  assert.equal(report.passed, false);
  assert.equal(violationsFor(report, "I1").length, 1);
  assert.match(violationsFor(report, "I1")[0].detail, /DND/);
});

test("a human escalation is not treated as contacting a DND customer", () => {
  // Escalating to an internal queue doesn't message anyone, so it must not
  // trip the consent rule.
  const input = baseInput({ consent: [{ customer_id: "cust_2", dnd: true }] });
  const report = verifyConformance(input);

  assert.equal(violationsFor(report, "I1").length, 0);
});

test("catches an event that exceeded the retry ceiling", () => {
  const input = baseInput();
  for (let i = 0; i < 4; i++) {
    input.actions.push({
      agent_decision_id: "dec_1",
      channel: "email",
      status: "sent",
      attempt_number: i + 2,
      executed_at: `2026-09-0${i + 2}T10:00:00.000Z`,
    });
  }

  const report = verifyConformance(input);
  assert.equal(violationsFor(report, "I2").length, 1);
  assert.match(violationsFor(report, "I2")[0].detail, /ceiling is 3/);
});

test("catches two contacts to the same customer inside the cooldown", () => {
  const input = baseInput();
  input.events.push({
    id: "evt_3",
    customer_id: "cust_1", // same customer as evt_1
    amount_paise: 20000,
    root_cause: "gateway_error",
  });
  input.decisions.push({
    id: "dec_3",
    revenue_event_id: "evt_3",
    chosen_action: "send_retry_link_email",
    rationale: "Retry.",
  });
  input.actions.push({
    agent_decision_id: "dec_3",
    channel: "email",
    status: "sent",
    executed_at: "2026-09-01T11:00:00.000Z", // 1 hour after evt_1, cooldown is 4h
    attempt_number: 1,
  });

  const report = verifyConformance(input);
  assert.equal(violationsFor(report, "I3").length, 1);
  assert.match(violationsFor(report, "I3")[0].detail, /60 minutes apart/);
});

test("accepts contacts to the same customer outside the cooldown", () => {
  const input = baseInput();
  input.events.push({
    id: "evt_3",
    customer_id: "cust_1",
    amount_paise: 20000,
    root_cause: "gateway_error",
  });
  input.decisions.push({
    id: "dec_3",
    revenue_event_id: "evt_3",
    chosen_action: "send_retry_link_email",
    rationale: "Retry.",
  });
  input.actions.push({
    agent_decision_id: "dec_3",
    channel: "email",
    status: "sent",
    executed_at: "2026-09-01T16:00:00.000Z", // 6 hours later
    attempt_number: 1,
  });

  assert.equal(violationsFor(verifyConformance(input), "I3").length, 0);
});

test("catches an action outside the permitted set", () => {
  const input = baseInput();
  input.decisions[0].chosen_action = "issue_refund";

  const report = verifyConformance(input);
  assert.equal(violationsFor(report, "I4").length, 1);
  assert.match(violationsFor(report, "I4")[0].detail, /issue_refund/);
});

test("catches a decision recorded without a rationale", () => {
  const input = baseInput();
  input.decisions[1].rationale = "   ";

  const report = verifyConformance(input);
  assert.equal(violationsFor(report, "I5").length, 1);
});

test("catches a holdout control event that was acted on", () => {
  // This one protects the headline number as much as the customer: a single
  // contacted control event invalidates the measured lift.
  const input = baseInput();
  input.assignments = [
    { revenue_event_id: "evt_1", arm: "control" },
    { revenue_event_id: "evt_2", arm: "treated" },
  ];

  const report = verifyConformance(input);
  assert.equal(violationsFor(report, "I6").length, 1);
  assert.match(violationsFor(report, "I6")[0].detail, /measured lift is invalid/);
});

test("catches an action with no authorising decision", () => {
  const input = baseInput();
  input.actions.push({
    agent_decision_id: "dec_does_not_exist",
    channel: "whatsapp",
    status: "sent",
    attempt_number: 1,
    executed_at: "2026-09-01T12:00:00.000Z",
  });

  const report = verifyConformance(input);
  assert.equal(violationsFor(report, "I7").length, 1);
  assert.match(violationsFor(report, "I7")[0].detail, /unauthorised/);
});

test("an empty batch passes without dividing by zero", () => {
  const report = verifyConformance({
    events: [],
    decisions: [],
    actions: [],
    consent: [],
    assignments: [],
    policy: DEFAULT_POLICY,
  });

  assert.equal(report.passed, true);
  assert.equal(report.totalChecked, 0);
});

// --- Compliance cost

test("categorises stopping reasons by what they actually are", () => {
  assert.equal(categorise("customer_dnd_opt_out"), "compliance");
  assert.equal(categorise("holdout_control"), "measurement");
  assert.equal(categorise("negative_expected_value"), "economics");
  assert.equal(categorise("guardrail_check_failed:consent"), "degraded");
  assert.equal(categorise("not_recoverable_or_unknown_cause"), "unrecoverable");
});

test("prices what the stopping rules cost in foregone recovery", () => {
  const blocked: BlockedEvent[] = [
    {
      revenue_event_id: "e1",
      reason: "customer_dnd_opt_out",
      amount_paise: 100000,
      root_cause: "bank_timeout",
    },
    {
      revenue_event_id: "e2",
      reason: "cooldown_window_active",
      amount_paise: 200000,
      root_cause: "bank_timeout",
    },
  ];

  // Fixed 50% propensity keeps the arithmetic checkable.
  const report = estimateComplianceCost(blocked, () => 0.5, DEFAULT_POLICY);

  assert.equal(report.byCategory.compliance.count, 2);
  assert.equal(report.byCategory.compliance.foregonePaise, 150000);
  assert.equal(report.totalForegonePaise, 150000);
  assert.equal(report.basis, "estimated");
});

test("excludes deliberately unprofitable skips from the headline cost", () => {
  // Those were skipped because expected recovery didn't cover the cost of
  // trying — counting them as a loss double-counts a correct decision.
  const blocked: BlockedEvent[] = [
    {
      revenue_event_id: "e1",
      reason: "negative_expected_value",
      amount_paise: 100000,
      root_cause: "card_declined",
    },
  ];

  const report = estimateComplianceCost(blocked, () => 0.5, DEFAULT_POLICY);

  assert.equal(report.byCategory.economics.count, 1);
  assert.equal(report.totalForegonePaise, 0);
});

test("separates the price of measurement from the price of compliance", () => {
  const blocked: BlockedEvent[] = [
    {
      revenue_event_id: "e1",
      reason: "holdout_control",
      amount_paise: 100000,
      root_cause: "bank_timeout",
    },
    {
      revenue_event_id: "e2",
      reason: "customer_dnd_opt_out",
      amount_paise: 100000,
      root_cause: "bank_timeout",
    },
  ];

  const report = estimateComplianceCost(blocked, () => 0.4, DEFAULT_POLICY);

  assert.equal(report.byCategory.measurement.foregonePaise, 40000);
  assert.equal(report.byCategory.compliance.foregonePaise, 40000);
  // Both are real costs, but they buy different things.
  assert.equal(report.totalForegonePaise, 80000);
});
