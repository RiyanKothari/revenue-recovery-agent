"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ACTION_LABELS,
  Chip,
  Header,
  ROOT_CAUSE_LABELS,
  SectionTitle,
  label,
  reasonLabel,
  rupeesExact,
} from "../../ui";

/**
 * One payment's path through the pipeline.
 *
 * The stage spine is FIXED and rendered in the order the pipeline actually
 * runs — received, classified, guardrails, decided, executed, outcome.
 *
 * The order is the point, not a layout detail. Guardrails run BEFORE the
 * agent is asked anything, and their result is a hard veto: the model is
 * only ever asked *which* of three pre-approved actions fits, never
 * *whether* to act. A design that showed the checks after the decision would
 * depict a system that reasons first and validates afterwards — the opposite
 * of what this one does, and the opposite of what makes it safe.
 *
 * Rendering the full spine rather than only the stages that fired is
 * deliberate too: an event stopped at the guardrails must visibly NOT have
 * reached the agent, and a list of what happened cannot show an absence.
 */

interface Trace {
  stages: {
    stage: string;
    label: string;
    state: "passed" | "stopped" | "not_reached";
    at: string | null;
    detail: Record<string, any> | null;
  }[];
  stoppedAt: string | null;
  stopReason: string | null;
}

interface TracePayload {
  event_id: string;
  event: { amount_paise: number; root_cause: string | null; customer_id: string | null } | null;
  trace: Trace;
  decision: { chosen_action: string; rationale: string | null; from_cache?: boolean } | null;
  outcome: { recovered: boolean; recovered_amount_paise: number | null; resolved_at: string | null } | null;
  audit: { id: string; stage: string; detail: Record<string, any>; created_at: string }[];
}

export default function EventTracePage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<TracePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/event/${params.id}/trace`)
      .then(async (res) => {
        if (res.status === 404) throw new Error("No event with that id.");
        if (!res.ok) throw new Error("Could not load this trace.");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [params.id]);

  return (
    <div className="rr-page">
      <Header />

      <div id="main" role="main" className="rr-shell" style={{ paddingTop: 20 }}>
        <Link href="/dashboard" className="rr-chip rr-chip--neutral" style={{ textDecoration: "none" }}>
          ← Back to the ledger
        </Link>

        {error && (
          <div className="rr-card" style={{ marginTop: 16 }}>
            <span style={{ color: "var(--rr-text-2)", fontSize: 13 }}>{error}</span>
          </div>
        )}

        {!data && !error && (
          <div className="rr-card" style={{ marginTop: 16 }}>
            <span style={{ color: "var(--rr-text-3)", fontSize: 13 }}>Loading trace…</span>
          </div>
        )}

        {data && <TraceBody data={data} />}
      </div>
    </div>
  );
}

function TraceBody({ data }: { data: TracePayload }) {
  const { trace, event, decision, outcome } = data;

  const classified = data.audit.find((a) => a.stage === "classified");
  const received = data.audit.find((a) => a.stage === "event_received");
  const executed = data.audit.find((a) => a.stage === "action_executed");

  const recovered = outcome?.recovered === true;

  return (
    <>
      {/* --- Identity --- */}
      <div className="rr-card" style={{ margin: "16px 0" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <span className="rr-chip rr-chip--neutral rr-mono">
                {data.event_id.slice(0, 8).toUpperCase()}
              </span>
              {recovered ? (
                <Chip tone="green">Recovered</Chip>
              ) : trace.stoppedAt ? (
                <Chip tone="amber">{reasonLabel(trace.stopReason ?? undefined)}</Chip>
              ) : (
                <Chip tone="blue">In flight</Chip>
              )}
              {decision?.from_cache && <Chip tone="neutral">reasoning reused</Chip>}
            </div>

            <div className="rr-mono" style={{ fontSize: 30, fontWeight: 500 }}>
              {event ? rupeesExact(event.amount_paise) : "—"}
              <span style={{ fontSize: 13, color: "var(--rr-text-3)", marginLeft: 8 }}>INR</span>
            </div>

            {event?.root_cause && (
              <div style={{ fontSize: 12.5, color: "var(--rr-text-2)", marginTop: 4 }}>
                {label(ROOT_CAUSE_LABELS, event.root_cause)}
              </div>
            )}
          </div>

          <div style={{ textAlign: "right" }}>
            <div className="rr-mono" style={{ fontSize: 11, color: "var(--rr-text-3)" }}>
              {received?.created_at
                ? new Date(received.created_at).toISOString().replace("T", " ").slice(0, 19) + " UTC"
                : "—"}
            </div>
            {recovered && outcome?.resolved_at && (
              <div
                className="rr-mono"
                style={{ fontSize: 11, color: "var(--rr-green)", marginTop: 4 }}
              >
                recovered {new Date(outcome.resolved_at).toISOString().replace("T", " ").slice(0, 19)} UTC
              </div>
            )}
          </div>
        </div>
      </div>

      {/* --- The spine --- */}
      <div className="rr-card" style={{ marginBottom: 16 }}>
        <SectionTitle
          right={
            <span style={{ fontSize: 10.5, color: "var(--rr-text-3)" }}>
              reconstructed from the audit trail
            </span>
          }
        >
          Execution pipeline
        </SectionTitle>

        <div className="rr-pipeline">
          {trace.stages.map((stage, i) => (
            <PipelineStage
              key={stage.stage}
              stage={stage}
              previous={i > 0 ? trace.stages[i - 1] : null}
              isFirst={i === 0}
            />
          ))}
        </div>

        {trace.stoppedAt && (
          <div className="rr-notice" style={{ marginTop: 16, marginBottom: 0 }}>
            <span aria-hidden="true">■</span>
            <span>
              Stopped at <strong>{trace.stages.find((s) => s.stage === trace.stoppedAt)?.label}</strong>
              {trace.stopReason ? ` — ${reasonLabel(trace.stopReason)}.` : "."}{" "}
              Nothing downstream ran.
            </span>
          </div>
        )}
      </div>

      {/* --- The three substantive panels --- */}
      <div className="rr-trio">
        <div className="rr-card">
          <SectionTitle>Classification</SectionTitle>

          <div className="rr-stat__label">Root cause</div>
          <div style={{ marginBottom: 12 }}>
            <Chip tone="blue">{label(ROOT_CAUSE_LABELS, event?.root_cause ?? undefined)}</Chip>
          </div>

          {/* Deterministic, so there is no confidence score to show. Inventing
              one would dress a lookup table as a model. */}
          <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginBottom: 10 }}>
            Deterministic rules, not a model — an unrecognised failure routes to
            human review rather than being guessed at.
          </div>

          <div className="rr-stat__label">Raw error</div>
          <pre className="rr-pre rr-mono">
            {classified?.detail?.classification
              ? JSON.stringify(classified.detail.classification, null, 1)
              : "—"}
          </pre>
        </div>

        <div className="rr-card">
          <SectionTitle>Guardrails</SectionTitle>

          <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginBottom: 10 }}>
            Evaluated before the agent was asked anything. Each one fails closed.
          </div>

          <GuardrailChecks stopReason={trace.stopReason} stoppedAt={trace.stoppedAt} />
        </div>

        <div className="rr-card">
          <SectionTitle>Decision</SectionTitle>

          {decision ? (
            <>
              <div className="rr-stat__label">Action</div>
              <div style={{ marginBottom: 12 }}>
                <Chip tone="green">{label(ACTION_LABELS, decision.chosen_action)}</Chip>
              </div>

              <div className="rr-stat__label">Model</div>
              <div
                className="rr-mono"
                style={{ fontSize: 11.5, color: "var(--rr-text-2)", marginBottom: 12 }}
              >
                {executed?.detail?.model ??
                  data.audit.find((a) => a.stage === "agent_decided")?.detail?.model ??
                  "—"}
              </div>

              <div className="rr-stat__label">Rationale</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--rr-text)" }}>
                {decision.rationale ?? "—"}
              </div>

              {decision.from_cache && (
                <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginTop: 10 }}>
                  Reused from an identical situation. The rationale is the same because
                  the inputs were the same — the model was not asked again.
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--rr-text-2)" }}>
              The agent was never asked. This event stopped before the decision stage.
            </div>
          )}
        </div>
      </div>

      {/* The untouched record, underneath the rendered one. If the two ever
          disagree, the reader should be able to see it rather than take the
          summary's word for it. */}
      <details className="rr-card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--rr-text-2)" }}>
          Raw audit trail — {data.audit.length} rows
        </summary>
        <pre className="rr-pre rr-mono" style={{ marginTop: 12, maxHeight: 420 }}>
          {JSON.stringify(data.audit, null, 1)}
        </pre>
      </details>
    </>
  );
}

function PipelineStage({
  stage,
  previous,
  isFirst,
}: {
  stage: Trace["stages"][number];
  previous: Trace["stages"][number] | null;
  isFirst: boolean;
}) {
  const glyph = stage.state === "passed" ? "✓" : stage.state === "stopped" ? "■" : "";

  return (
    <>
      {!isFirst && (
        <div
          className={`rr-connector ${
            previous && previous.state === "passed" && stage.state !== "not_reached"
              ? ""
              : "rr-connector--dead"
          }`}
        />
      )}
      <div className={`rr-stage rr-stage--${stage.state}`}>
        <div className="rr-stage__node">{glyph}</div>
        <div className="rr-stage__label">{stage.label}</div>
        <div className="rr-stage__time rr-mono">
          {stage.at ? new Date(stage.at).toLocaleTimeString("en-IN", { hour12: false }) : "—"}
        </div>
      </div>
    </>
  );
}

/**
 * The four checks, in the order guardrails.ts runs them.
 *
 * Named from the code rather than invented: a panel listing a check the
 * system does not perform would be the single most damaging thing on this
 * screen, because it is the screen a sceptic reads most carefully.
 */
const CHECKS: { id: string; label: string; blocks: string[] }[] = [
  { id: "consent", label: "Consent / DND", blocks: ["customer_dnd_opt_out", "no_customer_identifier"] },
  { id: "retry_ceiling", label: "Retry ceiling", blocks: ["max_retry_attempts_reached"] },
  { id: "cooldown", label: "Cooldown window", blocks: ["cooldown_window_active"] },
  {
    id: "dispute",
    label: "Refund / dispute kill-switch",
    blocks: ["refund_or_dispute_flagged", "refund_or_dispute"],
  },
];

function GuardrailChecks({
  stopReason,
  stoppedAt,
}: {
  stopReason: string | null;
  stoppedAt: string | null;
}) {
  // A degraded check refuses without naming which one, so nothing is claimed
  // to have passed when the pipeline could not evaluate it.
  const degraded = stopReason?.startsWith("guardrail_check_failed") ?? false;
  const blockedHere = stoppedAt === "stopping_rule_triggered";

  return (
    <div>
      {CHECKS.map((check) => {
        const blocked = !degraded && blockedHere && stopReason && check.blocks.includes(stopReason);
        const unknown = degraded;

        return (
          <div
            key={check.id}
            className={`rr-check ${blocked ? "rr-check--blocked" : unknown ? "" : "rr-check--ok"}`}
          >
            <span>{check.label}</span>
            {blocked ? (
              <Chip tone="red">blocked</Chip>
            ) : unknown ? (
              <Chip tone="amber">unavailable</Chip>
            ) : (
              <span style={{ color: "var(--rr-green)" }}>✓</span>
            )}
          </div>
        );
      })}

      {degraded && (
        <div style={{ fontSize: 11, color: "var(--rr-amber)", marginTop: 8, lineHeight: 1.5 }}>
          A check could not be evaluated, so the action was refused. A rule that cannot
          prove an action is safe does not permit it.
        </div>
      )}
    </div>
  );
}
