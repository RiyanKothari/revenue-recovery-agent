import type { RecoveryPolicy } from "./policy";

/**
 * Independent conformance verifier.
 *
 * Guardrails ENFORCE the safety rules while the pipeline runs. This module
 * PROVES they held, afterwards, by re-deriving each property from what was
 * actually recorded — the audit log, the actions table, the consent table.
 *
 * The important design constraint is that this file deliberately shares no
 * code with the enforcement path. It restates each rule independently rather
 * than importing the constants guardrails.ts uses. If it imported the same
 * logic, a bug in that logic would pass its own check and the whole exercise
 * would be a tautology. Restating the rule is the point: two independent
 * expressions of the same invariant have to agree, or something is wrong.
 *
 * This is what makes "compliant escalation, stopping rules, an audit trail"
 * a checkable claim rather than an assertion — the output is a mechanical
 * pass/fail over every event in the batch, not a description of intent.
 */

/** Restated independently, on purpose — see the note above. */
const PERMITTED_ACTIONS = new Set([
  "send_retry_link_whatsapp",
  "send_retry_link_email",
  "escalate_human",
]);

/** Channels that actually contact a customer. */
const CONTACTING_CHANNELS = new Set(["whatsapp", "email", "sms"]);

export interface ConformanceInput {
  events: {
    id: string;
    customer_id: string | null;
    amount_paise: number;
    root_cause: string | null;
  }[];
  decisions: {
    id: string;
    revenue_event_id: string;
    chosen_action: string;
    rationale: string | null;
  }[];
  actions: {
    agent_decision_id: string;
    channel: string;
    status: string;
    attempt_number: number;
    executed_at: string;
  }[];
  consent: { customer_id: string; dnd: boolean }[];
  assignments: { revenue_event_id: string; arm: string }[];
  policy: RecoveryPolicy;
}

export interface Violation {
  invariant: string;
  severity: "critical" | "high";
  revenueEventId?: string;
  detail: string;
}

export interface InvariantResult {
  id: string;
  description: string;
  severity: "critical" | "high";
  checked: number;
  violations: Violation[];
}

export interface ConformanceReport {
  passed: boolean;
  totalChecked: number;
  totalViolations: number;
  results: InvariantResult[];
}

/** Joins the tables once so each invariant can read from a flat view. */
function buildIndex(input: ConformanceInput) {
  const eventById = new Map(input.events.map((e) => [e.id, e]));
  const decisionById = new Map(input.decisions.map((d) => [d.id, d]));
  const dndCustomers = new Set(
    input.consent.filter((c) => c.dnd).map((c) => c.customer_id)
  );
  const armByEvent = new Map(input.assignments.map((a) => [a.revenue_event_id, a.arm]));

  // Every executed action, resolved back to its decision and event. A null
  // decision is itself a finding (see I7), so it is kept rather than dropped.
  type ResolvedAction = {
    action: ConformanceInput["actions"][number];
    decision: ConformanceInput["decisions"][number] | null;
    event: ConformanceInput["events"][number] | null;
  };

  const resolvedActions: ResolvedAction[] = input.actions.map((action) => {
    const decision = decisionById.get(action.agent_decision_id) ?? null;
    const event = decision ? (eventById.get(decision.revenue_event_id) ?? null) : null;
    return { action, decision, event };
  });

  return { eventById, decisionById, dndCustomers, armByEvent, resolvedActions };
}

export function verifyConformance(input: ConformanceInput): ConformanceReport {
  const idx = buildIndex(input);
  const results: InvariantResult[] = [];

  // --- I1. Consent is absolute.
  {
    const violations: Violation[] = [];
    for (const { action, event } of idx.resolvedActions) {
      if (!CONTACTING_CHANNELS.has(action.channel)) continue;
      if (!event?.customer_id) continue;
      if (idx.dndCustomers.has(event.customer_id)) {
        violations.push({
          invariant: "I1",
          severity: "critical",
          revenueEventId: event.id,
          detail: `Customer ${event.customer_id} has DND set but was contacted via ${action.channel}.`,
        });
      }
    }
    results.push({
      id: "I1",
      description: "No customer with DND set was ever contacted",
      severity: "critical",
      checked: idx.resolvedActions.filter((r) => CONTACTING_CHANNELS.has(r.action.channel))
        .length,
      violations,
    });
  }

  // --- I2. The retry ceiling was never exceeded.
  {
    const violations: Violation[] = [];
    const actionsPerEvent = new Map<string, number>();

    for (const { action, decision } of idx.resolvedActions) {
      if (!decision) continue;
      const eventId = decision.revenue_event_id;
      actionsPerEvent.set(eventId, (actionsPerEvent.get(eventId) ?? 0) + 1);
    }

    for (const [eventId, count] of actionsPerEvent) {
      if (count > input.policy.maxRetryAttempts) {
        violations.push({
          invariant: "I2",
          severity: "critical",
          revenueEventId: eventId,
          detail: `${count} recovery actions recorded, ceiling is ${input.policy.maxRetryAttempts}.`,
        });
      }
    }

    results.push({
      id: "I2",
      description: `No event exceeded ${input.policy.maxRetryAttempts} recovery attempts`,
      severity: "critical",
      checked: actionsPerEvent.size,
      violations,
    });
  }

  // --- I3. The cooldown window was respected, per customer, across events.
  {
    const violations: Violation[] = [];
    const byCustomer = new Map<string, Date[]>();

    for (const { action, event } of idx.resolvedActions) {
      if (!CONTACTING_CHANNELS.has(action.channel)) continue;
      if (!event?.customer_id) continue;
      const when = new Date(action.executed_at);
      if (Number.isNaN(when.getTime())) continue;
      const list = byCustomer.get(event.customer_id) ?? [];
      list.push(when);
      byCustomer.set(event.customer_id, list);
    }

    const windowMs = input.policy.cooldownMinutes * 60 * 1000;

    for (const [customerId, timestamps] of byCustomer) {
      timestamps.sort((a, b) => a.getTime() - b.getTime());
      for (let i = 1; i < timestamps.length; i++) {
        const gap = timestamps[i].getTime() - timestamps[i - 1].getTime();
        if (gap < windowMs) {
          violations.push({
            invariant: "I3",
            severity: "critical",
            detail: `Customer ${customerId} was contacted twice ${Math.round(gap / 60000)} minutes apart; cooldown is ${input.policy.cooldownMinutes}.`,
          });
        }
      }
    }

    results.push({
      id: "I3",
      description: `No customer was contacted twice within ${input.policy.cooldownMinutes} minutes`,
      severity: "critical",
      checked: byCustomer.size,
      violations,
    });
  }

  // --- I4. The agent never acted outside its permitted action set.
  {
    const violations: Violation[] = [];
    for (const decision of input.decisions) {
      if (!PERMITTED_ACTIONS.has(decision.chosen_action)) {
        violations.push({
          invariant: "I4",
          severity: "critical",
          revenueEventId: decision.revenue_event_id,
          detail: `Recorded action "${decision.chosen_action}" is outside the permitted set.`,
        });
      }
    }
    results.push({
      id: "I4",
      description: "Every decision chose an action from the permitted set",
      severity: "critical",
      checked: input.decisions.length,
      violations,
    });
  }

  // --- I5. Every decision is explainable.
  {
    const violations: Violation[] = [];
    for (const decision of input.decisions) {
      if (!decision.rationale || decision.rationale.trim().length === 0) {
        violations.push({
          invariant: "I5",
          severity: "high",
          revenueEventId: decision.revenue_event_id,
          detail: "Decision recorded with no rationale — not explainable after the fact.",
        });
      }
    }
    results.push({
      id: "I5",
      description: "Every decision carries a written rationale",
      severity: "high",
      checked: input.decisions.length,
      violations,
    });
  }

  // --- I6. Experimental integrity: the control arm was genuinely untouched.
  // A single contacted control event invalidates the measured lift, so this
  // protects the headline number as much as the customer.
  {
    const violations: Violation[] = [];
    let checked = 0;

    for (const { action, event } of idx.resolvedActions) {
      if (!event) continue;
      if (idx.armByEvent.get(event.id) !== "control") continue;
      checked += 1;
      violations.push({
        invariant: "I6",
        severity: "critical",
        revenueEventId: event.id,
        detail: `Event assigned to the control arm received a ${action.channel} action — measured lift is invalid.`,
      });
    }

    results.push({
      id: "I6",
      description: "No holdout control event was ever acted on",
      severity: "critical",
      checked: [...idx.armByEvent.values()].filter((a) => a === "control").length,
      violations,
    });
  }

  // --- I7. Every action traces back to a recorded decision.
  // An action with no decision is an action nobody authorised.
  {
    const violations: Violation[] = [];
    for (const { action, decision } of idx.resolvedActions) {
      if (!decision) {
        violations.push({
          invariant: "I7",
          severity: "critical",
          detail: `Action on decision ${action.agent_decision_id} has no matching agent_decisions row — unauthorised action.`,
        });
      }
    }
    results.push({
      id: "I7",
      description: "Every executed action traces to a recorded decision",
      severity: "critical",
      checked: idx.resolvedActions.length,
      violations,
    });
  }

  const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);

  return {
    passed: totalViolations === 0,
    totalChecked: results.reduce((sum, r) => sum + r.checked, 0),
    totalViolations,
    results,
  };
}
