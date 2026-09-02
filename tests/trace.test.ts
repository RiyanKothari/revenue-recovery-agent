import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrace, type TraceAuditRow } from "../lib/trace";

/**
 * The trace view's job is to show where an event stopped. Its failure mode is
 * showing a stage as reached when nothing was recorded for it — a view that
 * fills in gaps is worse than no view, because it looks like evidence.
 */

function row(stage: string, minute: number, detail: Record<string, unknown> = {}): TraceAuditRow {
  return {
    stage,
    detail,
    created_at: `2026-09-02T10:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

function stateOf(trace: ReturnType<typeof buildTrace>, stage: string) {
  return trace.stages.find((s) => s.stage === stage)?.state;
}

test("a fully processed event shows every stage reached", () => {
  const trace = buildTrace([
    row("event_received", 1),
    row("classified", 1),
    row("agent_decided", 2),
    row("action_executed", 2),
    row("outcome_recorded", 30),
  ]);

  assert.equal(trace.stoppedAt, null);
  assert.equal(trace.stopReason, null);
  for (const stage of trace.stages) {
    assert.equal(stage.state, "passed", `${stage.stage} should be passed`);
  }
});

test("stages with no record are not reached, never assumed to have passed", () => {
  const trace = buildTrace([row("event_received", 1), row("classified", 1)]);

  assert.equal(stateOf(trace, "agent_decided"), "not_reached");
  assert.equal(stateOf(trace, "action_executed"), "not_reached");
  assert.equal(stateOf(trace, "outcome_recorded"), "not_reached");
});

test("a guardrail block halts at the guardrail node", () => {
  const trace = buildTrace([
    row("event_received", 1),
    row("classified", 1),
    row("stopping_rule_triggered", 1, { reason: "customer_dnd_opt_out" }),
  ]);

  assert.equal(trace.stoppedAt, "stopping_rule_triggered");
  assert.equal(trace.stopReason, "customer_dnd_opt_out");
  assert.equal(stateOf(trace, "stopping_rule_triggered"), "stopped");
  assert.equal(stateOf(trace, "agent_decided"), "not_reached");
});

test("an economic decline halts after the agent, not at the guardrails", () => {
  // Attributing every stop to the guardrail node would report the agent's own
  // judgment ("not worth chasing") as a compliance block — the screen would
  // credit the safety rules for a decision the economics made.
  const trace = buildTrace([
    row("event_received", 1),
    row("classified", 1),
    row("agent_decided", 2, { action: "send_retry_link_whatsapp" }),
    row("stopping_rule_triggered", 2, { reason: "negative_expected_value" }),
  ]);

  assert.equal(trace.stoppedAt, "agent_decided");
  assert.equal(trace.stopReason, "negative_expected_value");
  assert.equal(stateOf(trace, "stopping_rule_triggered"), "passed");
  assert.equal(stateOf(trace, "agent_decided"), "stopped");
});

test("rows arriving newest-first still produce a forward-ordered trace", () => {
  const forward = buildTrace([
    row("event_received", 1),
    row("classified", 1),
    row("agent_decided", 2),
  ]);
  const reversed = buildTrace([
    row("agent_decided", 2),
    row("classified", 1),
    row("event_received", 1),
  ]);

  assert.deepEqual(
    reversed.stages.map((s) => s.state),
    forward.stages.map((s) => s.state)
  );
});

test("a repeated stage keeps the first occurrence", () => {
  // Webhook retries append; the trace should show when the stage first
  // happened, not when it was last re-recorded.
  const trace = buildTrace([
    row("event_received", 1),
    row("event_received", 9),
    row("classified", 1),
  ]);

  const received = trace.stages.find((s) => s.stage === "event_received");
  assert.ok(received?.at?.endsWith("10:01:00.000Z"));
});

test("a stopping rule with no readable reason does not invent one", () => {
  const trace = buildTrace([
    row("event_received", 1),
    row("classified", 1),
    row("stopping_rule_triggered", 1, { note: "something else" }),
  ]);

  assert.equal(trace.stopReason, null);
  assert.equal(trace.stoppedAt, "stopping_rule_triggered");
});

test("an event with no audit rows at all yields an empty, honest spine", () => {
  const trace = buildTrace([]);

  assert.equal(trace.stoppedAt, null);
  assert.equal(trace.stages.length, 6);
  // The guardrail node is the one stage that reads as passed on absence, so
  // everything else must be not_reached.
  const notReached = trace.stages.filter((s) => s.state === "not_reached");
  assert.equal(notReached.length, 5);
});
