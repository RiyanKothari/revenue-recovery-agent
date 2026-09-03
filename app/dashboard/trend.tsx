"use client";

import { Chip, SectionTitle, rupees } from "./ui";

/**
 * The time axis the Desk was missing.
 *
 * Everything else on the page is a snapshot: what the batch did, in total.
 * That answers "does it work" and cannot answer "is it working better or
 * worse than last week", which is the question anyone responsible for the
 * number asks second.
 *
 * Drawn as inline SVG rather than pulled from a charting library, because
 * the whole page is about ten kilobytes of custom visuals and a chart
 * dependency would cost more than it saves for two series.
 */

export interface DayPoint {
  day: string;
  failures: number;
  recovered: number;
  atRiskPaise: number;
  recoveredPaise: number;
}

export interface ArmPoint {
  day: string;
  treatedRate: number | null;
  controlRate: number | null;
  treatedN: number;
  controlN: number;
}

/* Wide and short on purpose. The ledger is the anchor of this page, and a
   trend chart at a square-ish aspect ratio pushed it below the fold — the
   supporting evidence outgrowing the thing it supports. */
const W = 960;
const H = 132;
const PAD = { top: 12, right: 12, bottom: 22, left: 36 };

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function RecoveryTrend({ daily }: { daily: DayPoint[] }) {
  if (daily.length < 2) {
    return (
      <div className="rr-card">
        <SectionTitle>Recovery over time</SectionTitle>
        <div style={{ fontSize: 12.5, color: "var(--rr-text-2)" }}>
          Not enough days yet — this needs failures spread over more than one day.
        </div>
      </div>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const maxFailures = Math.max(...daily.map((d) => d.failures));
  const x = (i: number) => PAD.left + (innerW * i) / (daily.length - 1);
  const barW = Math.max(6, (innerW / daily.length) * 0.55);

  const recoveredPath = daily
    .map((d, i) => {
      const y = PAD.top + innerH - (innerH * d.recovered) / maxFailures;
      return `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const totalFailures = daily.reduce((s, d) => s + d.failures, 0);
  const totalRecovered = daily.reduce((s, d) => s + d.recovered, 0);

  return (
    <div className="rr-card">
      <SectionTitle
        right={
          <Chip tone="neutral">{`${daily.length} days`}</Chip>
        }
      >
        Recovery over time
      </SectionTitle>

      <svg viewBox={`0 0 ${W} ${H}`} className="rr-chart" role="img">
        <title>
          {`Daily failures and recoveries across ${daily.length} days: ` +
            daily.map((d) => `${d.day} ${d.recovered} of ${d.failures}`).join(", ")}
        </title>

        {/* Gridlines carry the scale so the bars do not have to be read
            against nothing. */}
        {[0, 0.5, 1].map((f) => {
          const y = PAD.top + innerH * (1 - f);
          return (
            <g key={f}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--rr-border)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="var(--rr-text-3)"
                style={{ fontFamily: "var(--font-mono), monospace" }}
              >
                {Math.round(maxFailures * f)}
              </text>
            </g>
          );
        })}

        {daily.map((d, i) => {
          const h = (innerH * d.failures) / maxFailures;
          return (
            <g key={d.day}>
              <rect
                x={x(i) - barW / 2}
                y={PAD.top + innerH - h}
                width={barW}
                height={h}
                rx="2"
                fill="var(--rr-blue)"
                opacity="0.22"
              />
              <rect
                x={x(i) - barW / 2}
                y={PAD.top + innerH - (innerH * d.recovered) / maxFailures}
                width={barW}
                height={(innerH * d.recovered) / maxFailures}
                rx="2"
                fill="var(--rr-green)"
                opacity="0.55"
              />
              <title>{`${shortDay(d.day)} — ${d.recovered} recovered of ${d.failures} failures, ${rupees(d.recoveredPaise)}`}</title>
            </g>
          );
        })}

        <path d={recoveredPath} fill="none" stroke="var(--rr-green)" strokeWidth="1.6" />
        {daily.map((d, i) => (
          <circle
            key={d.day}
            cx={x(i)}
            cy={PAD.top + innerH - (innerH * d.recovered) / maxFailures}
            r="2.4"
            fill="var(--rr-green)"
          />
        ))}

        {daily.map((d, i) =>
          i % Math.ceil(daily.length / 5) === 0 || i === daily.length - 1 ? (
            <text
              key={d.day}
              x={x(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize="9"
              fill="var(--rr-text-3)"
            >
              {shortDay(d.day)}
            </text>
          ) : null
        )}
      </svg>

      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--rr-text-2)", marginTop: 8 }}>
        <span>
          <span className="rr-swatch" style={{ background: "var(--rr-blue)", opacity: 0.4 }} />
          {` ${totalFailures} failures`}
        </span>
        <span>
          <span className="rr-swatch" style={{ background: "var(--rr-green)" }} />
          {` ${totalRecovered} recovered`}
        </span>
      </div>
    </div>
  );
}

/**
 * Which failure types repay the effort.
 *
 * Ordered by rupees recovered rather than by rate — a high rate on eleven
 * tiny failures is not where anyone should spend the next hour. A cause with
 * too few observations shows its counts and withholds the rate, because a
 * percentage drawn from four events will be believed at face value.
 */
export interface CauseRow {
  cause: string;
  events: number;
  recovered: number;
  recoveryRate: number | null;
  atRiskPaise: number;
  recoveredPaise: number;
  sparse: boolean;
}

export function CausePerformance({
  rows,
  labelFor,
}: {
  rows: CauseRow[];
  labelFor: (cause: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rr-card">
        <SectionTitle>Where recovery pays</SectionTitle>
        <div style={{ fontSize: 12.5, color: "var(--rr-text-3)" }}>Nothing classified yet.</div>
      </div>
    );
  }

  const maxRecovered = Math.max(1, ...rows.map((r) => r.recoveredPaise));
  const bestRate = Math.max(...rows.filter((r) => !r.sparse).map((r) => r.recoveryRate ?? 0), 0);

  return (
    <div className="rr-card">
      <SectionTitle right={<Chip tone="neutral">by rupees recovered</Chip>}>
        Where recovery pays
      </SectionTitle>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((row) => (
          <div key={row.cause}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: 10,
                marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 12.5, color: "var(--rr-text)" }}>
                {labelFor(row.cause)}
                {/* The best-performing cause is named, not left to be
                    inferred from bar lengths that differ by a few pixels. */}
                {!row.sparse && row.recoveryRate === bestRate && bestRate > 0 && (
                  <span style={{ marginLeft: 6 }}>
                    <Chip tone="green">best rate</Chip>
                  </span>
                )}
              </span>
              <span className="rr-mono" style={{ fontSize: 11.5, color: "var(--rr-text-2)" }}>
                {row.sparse ? (
                  <span title={`Only ${row.events} events — too few to quote a rate`}>
                    {`${row.recovered}/${row.events}`}
                  </span>
                ) : (
                  `${(row.recoveryRate! * 100).toFixed(0)}% · ${rupees(row.recoveredPaise)}`
                )}
              </span>
            </div>

            <div className="rr-meter">
              <div
                className="rr-meter__fill"
                style={{ width: `${(row.recoveredPaise / maxRecovered) * 100}%` }}
              />
              {row.sparse && (
                <span className="rr-meter__note">too few events to rate</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
