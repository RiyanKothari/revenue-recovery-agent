"use client";

import type { PriceOfProofReport } from "@/lib/price-of-proof";

/**
 * The Price of Proof chart, in its own file so it can be rendered in a plain
 * Node test. Everything beside it in price-of-proof.tsx goes through Blade,
 * which needs a theme provider and takes seconds to import; this needs
 * neither. It earned a test the hard way: its axis shipped to production
 * reading "+31.818181818181817pp".
 */

const W = 320;
const H = 120;
const PAD = { l: 30, r: 8, t: 8, b: 18 };

/**
 * The axis half-range in percentage points: the largest estimate plus some
 * headroom, rounded UP to a whole 10pp, and kept between 10 and 60 so the
 * early, very wide part of the band does not flatten the rest.
 */
export function axisHalfRangePp(estimatesPp: number[]): number {
  const peak = estimatesPp.length ? Math.max(...estimatesPp) + 10 : 10;
  return Math.min(60, Math.max(10, Math.ceil(peak / 10) * 10));
}

export function ProofBand({ report }: { report: PriceOfProofReport }) {
  const s = report.series;
  const n = s[s.length - 1].index;
  // Clipped, so the narrowing stays legible; the axis says where.
  const yMax = axisHalfRangePp(s.map((p) => p.estimatePp));
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
