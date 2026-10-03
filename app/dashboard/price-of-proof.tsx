"use client";

import type { PriceOfProofReport } from "@/lib/price-of-proof";
import { Chip, SectionTitle, rupees } from "./ui";
import { ProofBand as Band } from "./proof-band";

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
