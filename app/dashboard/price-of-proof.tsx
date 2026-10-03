"use client";

import type { PriceOfProofReport } from "@/lib/price-of-proof";
import { Chip, SectionTitle, rupees } from "./ui";

/**
 * Price of Proof: the holdout, priced, and the moment it stopped being worth it.
 *
 * The lift card above answers "did the agent cause the recovery". This
 * answers the merchant's next question, the one every holdout dodges: how
 * long do I have to keep withholding help to keep knowing that? The band is a
 * confidence sequence — valid at every point on the chart at once, so reading
 * it at any moment, as often as you like, is legitimate. Where it clears zero
 * is where the experiment had already earned its answer.
 */

const W = 320;
const H = 120;
const PAD = { l: 30, r: 8, t: 8, b: 18 };

export function PriceOfProofCard({ report }: { report: PriceOfProofReport }) {
  const tone =
    report.verdict === "proven" ? "green" : report.verdict === "harm" ? "red" : "neutral";
  const chip =
    report.verdict === "proven"
      ? "Proven"
      : report.verdict === "harm"
        ? "Harm proven"
        : report.verdict === "no_data"
          ? "No data"
          : "Still learning";

  return (
    <div className="rr-card">
      <SectionTitle right={<Chip tone={tone}>{chip}</Chip>}>Price of proof</SectionTitle>

      {report.series.length > 1 && <Band report={report} />}

      {report.verdict === "proven" && report.provenAt && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
          <Figure
            value={`Event ${report.provenAt.index.toLocaleString("en-IN")}`}
            label={`of ${report.observations.toLocaleString("en-IN")}: when the lift was proven`}
          />
          <Figure
            value={`${report.controlAfterProof.toLocaleString("en-IN")} customers`}
            label={`of ${report.controlTotal.toLocaleString("en-IN")} held out after it was already proven`}
          />
          <Figure
            value={`≥ ${rupees(report.forgoneAfterProofPaise)}`}
            label="recovery those customers likely missed, at the lower bound"
            tone="amber"
          />
          <Figure
            value={rupees(report.forgoneAfterProofPointPaise)}
            label="the same at the point estimate, for scale"
          />
        </div>
      )}

      <div style={{ fontSize: 11.5, color: "var(--rr-text-2)", marginTop: 10, lineHeight: 1.55 }}>
        {report.reason}
      </div>

      <div style={{ fontSize: 10.5, color: "var(--rr-text-3)", marginTop: 8, lineHeight: 1.5 }}>
        {`An anytime-valid ${Math.round((1 - report.alpha) * 100)}% confidence sequence (empirical-Bernstein): checking it after every event cannot inflate its error, unlike re-running a fixed test, which on simulated no-effect runs "proved" a lift about one time in five.`}
      </div>
    </div>
  );
}

function Figure({ value, label, tone }: { value: string; label: string; tone?: "amber" }) {
  return (
    <div>
      <div
        className="rr-mono"
        style={{ fontSize: 15, color: tone === "amber" ? "var(--rr-amber)" : "var(--rr-text)" }}
      >
        {value}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--rr-text-3)", lineHeight: 1.4 }}>{label}</div>
    </div>
  );
}

function Band({ report }: { report: PriceOfProofReport }) {
  const s = report.series;
  const n = s[s.length - 1].index;
  // Clip the early, very wide part of the band so the narrowing is legible;
  // the axis says where it was clipped.
  // Rounded up to a whole 10pp so the axis reads +40pp, not +31.8181…pp.
  const yMax = Math.min(60, Math.max(10, Math.ceil(Math.max(...s.map((p) => p.estimatePp + 10)) / 10) * 10));
  const yMin = -yMax;
  const x = (i: number) => PAD.l + ((i - 1) / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => {
    const c = Math.max(yMin, Math.min(yMax, v));
    return PAD.t + ((yMax - c) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  };

  const upper = s.map((p) => `${x(p.index).toFixed(1)},${y(p.upperPp).toFixed(1)}`);
  const lower = [...s].reverse().map((p) => `${x(p.index).toFixed(1)},${y(p.lowerPp).toFixed(1)}`);
  const line = s.map((p) => `${x(p.index).toFixed(1)},${y(p.estimatePp).toFixed(1)}`).join(" ");
  const proof = report.provenAt;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={
        proof
          ? `Confidence band for the lift over ${n} events, clearing zero at event ${proof.index}.`
          : `Confidence band for the lift over ${n} events; it has not cleared zero.`
      }
      style={{ display: "block", marginTop: 4 }}
    >
      <polygon points={[...upper, ...lower].join(" ")} fill="var(--rr-blue-dim)" />
      <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--rr-border-strong)" />
      <polyline points={line} fill="none" stroke="var(--rr-blue)" strokeWidth={1.5} />
      {proof && (
        <>
          <line
            x1={x(proof.index)}
            x2={x(proof.index)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="var(--rr-green)"
            strokeDasharray="3 3"
          />
          <text x={x(proof.index) + 4} y={PAD.t + 9} fontSize={9} fill="var(--rr-green)">
            proven
          </text>
        </>
      )}
      <text x={2} y={y(yMax) + 4} fontSize={9} fill="var(--rr-text-3)">{`+${yMax}pp`}</text>
      <text x={2} y={y(0) + 3} fontSize={9} fill="var(--rr-text-3)">0</text>
      <text x={2} y={y(yMin) + 2} fontSize={9} fill="var(--rr-text-3)">{`${yMin}pp`}</text>
      <text x={W - PAD.r} y={H - 4} fontSize={9} fill="var(--rr-text-3)" textAnchor="end">
        {`events (${n.toLocaleString("en-IN")})`}
      </text>
    </svg>
  );
}
