import type { AuditStage } from "./audit";

/**
 * One event's path through the pipeline, reconstructed from the audit trail.
 *
 * The dashboard's feed answers "what is the agent doing"; this answers "what
 * happened to *this* payment, and where did it stop". Those are different
 * questions, and the second is the one a sceptical reader asks — which makes
 * this the view that has to be reconstructed from the record rather than
 * narrated by the code that did the work.
 *
 * That distinction is the whole design: nothing here is told what happened.
 * The stages are derived from `audit_log` rows alone, so a trace can only
 * show a stage that was actually recorded. If the pipeline took an action it
 * did not log, this view shows the gap rather than papering over it — which
 * is exactly what you want from an audit view and the opposite of what you
 * get from one built by threading a status object through the pipeline.
 */

export type StageState = "passed" | "stopped" | "not_reached";

export interface TraceStage {
  stage: AuditStage;
  label: string;
  state: StageState;
  /** When it happened, or null if the event never reached this stage. */
  at: string | null;
  detail: Record<string, unknown> | null;
}

export interface Trace {
  stages: TraceStage[];
  /** The stage that halted the event, or null if it ran to completion. */
  stoppedAt: AuditStage | null;
  /** Why it halted, read from the stopping rule's own detail. */
  stopReason: string | null;
}

/**
 * The pipeline in the order it runs. Rendering a fixed spine rather than only
 * the stages that fired is deliberate: an event that stopped at guardrails
 * should visibly *not* have reached the agent, and a list of what happened
 * cannot show an absence.
 */
const PIPELINE: { stage: AuditStage; label: string }[] = [
  { stage: "event_received", label: "Received" },
  { stage: "classified", label: "Classified" },
  { stage: "stopping_rule_triggered", label: "Guardrails" },
  { stage: "agent_decided", label: "Decided" },
  { stage: "action_executed", label: "Executed" },
  { stage: "outcome_recorded", label: "Outcome" },
];

export interface TraceAuditRow {
  stage: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export function buildTrace(rows: TraceAuditRow[]): Trace {
  // Oldest first, regardless of how the caller ordered them. A trace read
  // backwards would put the stop before the cause.
  const ordered = [...rows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const firstByStage = new Map<string, TraceAuditRow>();
  for (const row of ordered) {
    if (!firstByStage.has(row.stage)) firstByStage.set(row.stage, row);
  }

  const stopRow = firstByStage.get("stopping_rule_triggered") ?? null;
  const stopReason =
    stopRow && typeof stopRow.detail?.reason === "string"
      ? (stopRow.detail.reason as string)
      : null;

  /**
   * A stopping rule is recorded at the point the pipeline halts, and that is
   * not always the guardrail step — a negative expected value, an unusable
   * model response or a holdout assignment all stop the event further along.
   * So the halt is placed at the last stage that actually produced a record,
   * not at the guardrail node, otherwise every stop would look like a
   * compliance block and the screen would misattribute the agent's economic
   * judgment to its safety rules.
   */
  let stoppedAt: AuditStage | null = null;
  if (stopRow) {
    const reached = PIPELINE.filter(
      (p) => p.stage !== "stopping_rule_triggered" && firstByStage.has(p.stage)
    );
    const last = reached[reached.length - 1];
    stoppedAt =
      last && last.stage !== "event_received" && last.stage !== "classified"
        ? last.stage
        : "stopping_rule_triggered";
  }

  const stages: TraceStage[] = PIPELINE.map((node) => {
    const row = firstByStage.get(node.stage) ?? null;

    if (node.stage === "stopping_rule_triggered") {
      // The guardrail node reads as passed when nothing stopped the event —
      // an absent stopping rule is the checks holding, not a gap.
      return {
        stage: node.stage,
        label: node.label,
        state: stopRow && stoppedAt === "stopping_rule_triggered" ? "stopped" : "passed",
        at: row?.created_at ?? null,
        detail: row?.detail ?? null,
      };
    }

    if (row) {
      return {
        stage: node.stage,
        label: node.label,
        state: stoppedAt === node.stage ? "stopped" : "passed",
        at: row.created_at,
        detail: row.detail,
      };
    }

    // No record for this stage. Shown as not reached rather than assumed to
    // have succeeded quietly — an audit view that fills in gaps is not an
    // audit view.
    return {
      stage: node.stage,
      label: node.label,
      state: "not_reached",
      at: null,
      detail: null,
    };
  });

  return { stages, stoppedAt, stopReason };
}
