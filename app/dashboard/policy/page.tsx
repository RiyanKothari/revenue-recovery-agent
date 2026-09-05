"use client";

import { useState } from "react";
import { Chip, Header, SectionTitle, rupees } from "../ui";

/**
 * The Policy Lab — what a different policy would have done.
 *
 * Read-only by construction: it calls no model, contacts nobody, and writes
 * nothing. Every gate before the model is deterministic and every input it
 * read was written down, so this is a recomputation of recorded history
 * rather than a simulation of an imagined one.
 *
 * The screen's job is to keep two kinds of claim visually distinct:
 *
 *   - **Exact** — which events each policy acts on, holds back, declines or
 *     assigns to the holdout. Pure functions of recorded data.
 *   - **Estimated** — rupees recovered. Nobody knows whether a customer who
 *     was never contacted would have paid.
 *
 * Presenting the second with the same confidence as the first is what turns
 * a planning tool into a fabrication, so the estimated row is marked on the
 * row itself, not only in a footnote nobody reads.
 */

const DEFAULTS = {
  holdoutPercent: 10,
  minExpectedValuePaise: 0,
  cooldownMinutes: 240,
  maxRetryAttempts: 3,
};

interface ReplayTotals {
  acted: number;
  blocked_dnd: number;
  blocked_retry_ceiling: number;
  blocked_cooldown: number;
  declined_negative_ev: number;
  holdout_control: number;
}

interface ReplayResponse {
  events_replayed: number;
  baseline: { totals: ReplayTotals; actedAtRiskPaise: number };
  candidate: { totals: ReplayTotals; actedAtRiskPaise: number };
  deltas: ReplayTotals;
  estimate: {
    estimatedRecoveredPaise: number;
    treatedConversionRate: number;
    calibrated: boolean;
    assumption: string;
  } | null;
  fidelity: {
    eventsCompared: number;
    agreed: number;
    agreementRate: number;
    divergences: { replayed: string; recorded: string; count: number }[];
    note: string;
  };
}

export default function PolicyPage() {
  const [holdout, setHoldout] = useState(DEFAULTS.holdoutPercent);
  const [minEv, setMinEv] = useState(DEFAULTS.minExpectedValuePaise / 100);
  const [cooldown, setCooldown] = useState(DEFAULTS.cooldownMinutes / 60);
  const [retries, setRetries] = useState(DEFAULTS.maxRetryAttempts);

  const [result, setResult] = useState<ReplayResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replay = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdoutPercent: holdout,
          minExpectedValuePaise: Math.round(minEv * 100),
          cooldownMinutes: Math.round(cooldown * 60),
          maxRetryAttempts: retries,
        }),
      });
      if (!res.ok) throw new Error("Replay failed.");
      setResult(await res.json());
    } catch (e: any) {
      setError(e?.message ?? "Replay failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rr-page">
      <Header />

      <div id="main" role="main" className="rr-shell" style={{ paddingTop: 24 }}>
        <div className="rr-columns" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr)" }}>
          {/* --- Controls --- */}
          <div className="rr-card">
            <SectionTitle right={<Chip tone="amber">Sim mode</Chip>}>Policy tuning</SectionTitle>

            <Slider
              label="Holdout group"
              value={holdout}
              display={`${holdout}%`}
              min={0}
              max={50}
              step={1}
              onChange={setHoldout}
            />
            <Slider
              label="Min expected value"
              value={minEv}
              display={`₹${minEv}`}
              min={0}
              max={500}
              step={5}
              onChange={setMinEv}
            />
            <Slider
              label="Cooldown period"
              value={cooldown}
              display={`${cooldown}h`}
              min={0}
              max={72}
              step={1}
              onChange={setCooldown}
            />
            <Slider
              label="Retry ceiling"
              value={retries}
              display={`${retries} attempts`}
              min={1}
              max={10}
              step={1}
              onChange={setRetries}
            />

            <button className="rr-btn" onClick={replay} disabled={running} style={{ marginTop: 18 }}>
              {running ? "Replaying…" : "▶ Replay batch events"}
            </button>

            {/* Consent is deliberately absent from this panel. dndRespected is
                typed as a literal `true`, so a policy that relaxes it cannot
                be constructed — and a slider implying otherwise would
                advertise a capability the system refuses to have. */}
            <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginTop: 14, lineHeight: 1.55 }}>
              Consent is not tunable and has no control here. Every replayed policy
              respects DND without exception.
            </div>

            {error && (
              <div style={{ fontSize: 12, color: "var(--rr-red)", marginTop: 12 }}>{error}</div>
            )}
          </div>

          {/* --- Comparison --- */}
          <div>
            {!result ? (
              <div className="rr-card">
                <SectionTitle>Policy v1 → candidate</SectionTitle>
                <div style={{ fontSize: 12.5, color: "var(--rr-text-2)", lineHeight: 1.6 }}>
                  Move a control and replay. Recorded events are re-run through the same
                  deterministic gates under the new policy — no model is called, nothing
                  is sent, and no row is written.
                </div>
              </div>
            ) : (
              <Comparison result={result} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12, color: "var(--rr-text-2)" }}>{label}</span>
        <span className="rr-mono" style={{ fontSize: 12, color: "var(--rr-blue)" }}>
          {display}
        </span>
      </div>
      <input
        className="rr-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

const ROW_LABELS: Record<keyof ReplayTotals, string> = {
  acted: "Events acted on",
  holdout_control: "Held out to measure",
  blocked_cooldown: "Blocked by cooldown",
  blocked_retry_ceiling: "Blocked by retry ceiling",
  blocked_dnd: "Blocked by consent",
  declined_negative_ev: "Declined as unprofitable",
};

/**
 * Deltas are shown in neutral, not green and red.
 *
 * Every row here is a trade-off, and colouring one direction "good" would
 * have the tool answer the question it exists to ask. Fewer cooldown blocks
 * means more reach and less protection; a smaller holdout means more events
 * treated and a weaker measurement. The screen's job is to price the
 * trade-off accurately and let the reader make the call — a policy simulator
 * that quietly editorialises is worse than no simulator, because it looks
 * like analysis.
 *
 * The one exception is reach, where "acted on more events" has a defensible
 * reading on its own, and even that is stated rather than implied by hue.
 */
const REACH: keyof ReplayTotals = "acted";

function Comparison({ result }: { result: ReplayResponse }) {
  const keys = Object.keys(ROW_LABELS) as (keyof ReplayTotals)[];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="rr-card">
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
          <span className="rr-chip rr-chip--neutral">Policy v1</span>
          <span style={{ color: "var(--rr-text-3)" }}>→</span>
          <span className="rr-chip rr-chip--blue">Candidate (simulated)</span>
        </div>

        <table className="rr-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Current</th>
              <th>Simulated</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const before = result.baseline.totals[key];
              const after = result.candidate.totals[key];
              const delta = result.deltas[key];

              return (
                <tr key={key}>
                  <td className="rr-metric">{ROW_LABELS[key]}</td>
                  <td className="rr-mono">{before}</td>
                  <td className="rr-mono">{after}</td>
                  <td>
                    {delta === 0 ? (
                      <span style={{ color: "var(--rr-text-3)" }}>—</span>
                    ) : (
                      <Chip tone={key === REACH && delta > 0 ? "green" : "neutral"}>
                        {delta > 0 ? `↑ +${delta}` : `↓ ${delta}`}
                      </Chip>
                    )}
                  </td>
                </tr>
              );
            })}

            <tr>
              <td className="rr-metric">
                Value at risk addressed
                <span style={{ color: "var(--rr-text-3)", marginLeft: 6, fontSize: 10.5 }}>
                  exact
                </span>
              </td>
              <td className="rr-mono">{rupees(result.baseline.actedAtRiskPaise)}</td>
              <td className="rr-mono">{rupees(result.candidate.actedAtRiskPaise)}</td>
              <td>
                <DeltaMoney
                  delta={result.candidate.actedAtRiskPaise - result.baseline.actedAtRiskPaise}
                />
              </td>
            </tr>

            {result.estimate?.calibrated && (
              <tr>
                <td className="rr-metric">
                  Recovery
                  <span
                    className="rr-chip rr-chip--amber"
                    style={{ marginLeft: 8, fontSize: 10 }}
                  >
                    estimated
                  </span>
                </td>
                <td className="rr-mono" style={{ color: "var(--rr-text-3)" }}>
                  —
                </td>
                <td className="rr-mono">{rupees(result.estimate.estimatedRecoveredPaise)}</td>
                <td>
                  <span style={{ color: "var(--rr-text-3)" }}>—</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* --- The honesty boundary, on screen rather than in a README. --- */}
      <div className="rr-notice">
        <span aria-hidden="true">ℹ</span>
        <span>
          Every row is a trade-off — a shorter cooldown buys reach and spends protection,
          a smaller holdout buys treatment and spends certainty — so deltas are shown
          without a verdict. Simulated by replaying{" "}
          <strong>{result.events_replayed}</strong> recorded events
          through the same deterministic gates. Which events each policy touches is exact.{" "}
          <strong>Recovery is an estimate</strong> — it applies the conversion rates measured
          on the arms that actually ran, and assumes newly-eligible events behave like the
          ones already treated.
        </span>
      </div>

      {/* --- The engine, checked against the past it claims to model. --- */}
      <div className="rr-card">
        <SectionTitle
          right={
            <Chip tone={result.fidelity.agreementRate >= 0.99 ? "green" : "amber"}>
              {`${(result.fidelity.agreementRate * 100).toFixed(1)}% match`}
            </Chip>
          }
        >
          Replay fidelity
        </SectionTitle>

        <div className="rr-mono" style={{ fontSize: 15, marginBottom: 6 }}>
          {result.fidelity.agreed} / {result.fidelity.eventsCompared} events reproduced
        </div>

        <div style={{ fontSize: 11.5, color: "var(--rr-text-2)", lineHeight: 1.6 }}>
          The engine was pointed at the policy that actually ran and compared against the
          record. A counterfactual tool that cannot reproduce the past has no business
          predicting an alternative one.
        </div>

        {result.fidelity.divergences.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {result.fidelity.divergences.slice(0, 4).map((d, i) => (
              <div key={i} className="rr-line">
                <span className="rr-line__label">
                  replay said {d.replayed}, record said {d.recorded}
                </span>
                <span className="rr-line__value rr-mono">{d.count}</span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginTop: 8, lineHeight: 1.5 }}>
              {result.fidelity.note}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DeltaMoney({ delta }: { delta: number }) {
  if (delta === 0) return <span style={{ color: "var(--rr-text-3)" }}>—</span>;
  return (
    <Chip tone={delta > 0 ? "green" : "neutral"}>
      {delta > 0 ? `↑ +${rupees(delta)}` : `↓ ${rupees(Math.abs(delta))}`}
    </Chip>
  );
}
