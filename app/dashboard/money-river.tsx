"use client";

import { rupees } from "./ui";

/**
 * The money river — where the batch's rupees ended up.
 *
 * Strand thickness is proportional to **rupees, not event count**. That is
 * the whole reason this exists rather than a bar chart of stopping reasons:
 * a batch that blocks thirty-five small failures and recovers three large
 * ones is mostly-blocked by count and mostly-recovered by money, and the
 * money is the question a payments team is actually asking.
 *
 * Every terminal prints its own figure. Nothing here is encoded only in a
 * shape — the chart is the fast read, the numbers are the actual claim.
 */

export interface Bucket {
  id: string;
  label: string;
  events: number;
  amountPaise: number;
}

const TONE: Record<string, string> = {
  recovered: "#12b981",
  still_open: "#3395ff",
  held_back: "#f5a524",
  not_worth_chasing: "#5a6472",
  holdout: "#7c8798",
};

const NOTE: Record<string, string> = {
  recovered: "Payment came back after the agent acted",
  still_open: "Acted on, not yet resolved",
  held_back: "A guardrail stopped the attempt",
  not_worth_chasing: "Expected value did not clear the cost",
  holdout: "Deliberately untreated, to measure the baseline",
};

const WIDTH = 1000;
const HEIGHT = 250;
/* Bands are inset vertically so the second label line of the last strand
   still lands inside the viewBox instead of being clipped off. */
const BAND_TOP = 16;
const BAND_HEIGHT = HEIGHT - BAND_TOP * 2;
const SOURCE_X = 300;
const TARGET_X = 590;
const LABEL_X = 618;

export function MoneyRiver({
  buckets,
  totalAtRiskPaise,
}: {
  buckets: Bucket[];
  totalAtRiskPaise: number;
}) {
  const shown = buckets.filter((b) => b.amountPaise > 0);
  const total = shown.reduce((s, b) => s + b.amountPaise, 0);

  if (!total) {
    return (
      <div className="rr-river">
        <div className="rr-river__label">
          <div className="rr-caps rr-mono">The money river</div>
          <div className="rr-river__total rr-mono">—</div>
        </div>
        <div
          style={{
            height: HEIGHT,
            display: "grid",
            placeItems: "center",
            color: "var(--rr-text-3)",
            fontSize: 13,
          }}
        >
          No revenue-at-risk events yet. Send a test payment failure to begin.
        </div>
      </div>
    );
  }

  // Vertical space is shared out by rupees, with a floor so a small bucket
  // stays visible and hoverable rather than collapsing to a hairline.
  const gap = 8;
  const usable = BAND_HEIGHT - gap * (shown.length - 1);
  // Two lines of label sit beside each band, so nothing may be thinner than
  // the text it has to carry.
  const minBand = 30;
  const raw = shown.map((b) => (b.amountPaise / total) * usable);
  const deficit = raw.reduce((s, h) => s + Math.max(0, minBand - h), 0);
  const surplus = raw.reduce((s, h) => s + Math.max(0, h - minBand), 0);

  let cursor = BAND_TOP;
  const bands = shown.map((bucket, i) => {
    const height =
      raw[i] < minBand
        ? minBand
        : raw[i] - (surplus ? (deficit * (raw[i] - minBand)) / surplus : 0);
    const y = cursor;
    cursor += height + gap;
    return { bucket, y, height, centre: y + height / 2 };
  });

  const sourceHeight = Math.min(BAND_HEIGHT * 0.66, cursor - gap - BAND_TOP);
  const sourceTop = (HEIGHT - sourceHeight) / 2;
  let sourceCursor = sourceTop;

  return (
    <div className="rr-river">
      <div className="rr-river__label">
        <div className="rr-caps rr-mono">The money river</div>
        <div className="rr-river__total rr-mono">{rupees(totalAtRiskPaise)}</div>
        <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginTop: 2 }}>at risk</div>
      </div>

      {/*
        Below 900px the Sankey is replaced, not shrunk.
        Squeezed onto a phone its labels land at six pixels and the curves
        collapse into one another — a chart that is present but unreadable is
        worse than a simpler one that works, because it still occupies the
        space and still claims to be informative. The stacked bar carries the
        identical figures and the identical colour coding.
        Both are rendered and CSS picks one, so there is no hydration
        mismatch from measuring the viewport during render.
      */}
      <div className="rr-river__stack" aria-hidden="true">
        <div className="rr-river__stackbar">
          {shown.map((b) => (
            <div
              key={b.id}
              className="rr-river__seg"
              style={{
                flexGrow: b.amountPaise,
                background: TONE[b.id] ?? "#5a6472",
              }}
              title={b.label}
            />
          ))}
        </div>
        <div className="rr-river__legend">
          {shown.map((b) => (
            <div key={b.id} className="rr-river__legendrow">
              <span
                className="rr-river__swatch"
                style={{ background: TONE[b.id] ?? "#5a6472" }}
              />
              <span className="rr-river__legendlabel">{b.label}</span>
              <span className="rr-river__legendvalue rr-mono">
                {`${rupees(b.amountPaise)} · ${b.events}`}
              </span>
            </div>
          ))}
        </div>
      </div>

      <svg
        className="rr-river__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>
          {`Of ${rupees(totalAtRiskPaise)} at risk: ` +
            shown.map((b) => `${b.label} ${rupees(b.amountPaise)}`).join(", ")}
        </title>

        <defs>
          {bands.map(({ bucket }) => (
            <linearGradient
              key={bucket.id}
              id={`rr-grad-${bucket.id}`}
              x1="0"
              y1="0"
              x2="1"
              y2="0"
            >
              <stop offset="0%" stopColor="#3395ff" stopOpacity="0.55" />
              <stop offset="100%" stopColor={TONE[bucket.id] ?? "#5a6472"} stopOpacity="0.85" />
            </linearGradient>
          ))}
        </defs>

        {bands.map(({ bucket, centre, height }) => {
          const share = bucket.amountPaise / total;
          const sourceBand = sourceHeight * share;
          const sy = sourceCursor + sourceBand / 2;
          sourceCursor += sourceBand;

          const path = `M ${SOURCE_X} ${sy} C ${(SOURCE_X + TARGET_X) / 2} ${sy}, ${(SOURCE_X + TARGET_X) / 2} ${centre}, ${TARGET_X} ${centre}`;

          return (
            <g key={bucket.id} className="rr-strand">
              <path
                d={path}
                fill="none"
                stroke={`url(#rr-grad-${bucket.id})`}
                strokeWidth={Math.max(2, Math.min(sourceBand, height))}
                strokeLinecap="butt"
              />
              <rect
                x={TARGET_X}
                y={centre - Math.max(2, height) / 2}
                width="8"
                height={Math.max(2, height)}
                rx="3"
                fill={TONE[bucket.id] ?? "#5a6472"}
              />
              {/* Two particles per strand, so the hero reads as live traffic
                  without the particle count scaling with the batch. */}
              {[0, 1].map((n) => (
                <circle
                  key={n}
                  className="rr-particle"
                  r="2"
                  fill="#dce6f5"
                  opacity="0.75"
                  style={{
                    offsetPath: `path("${path}")`,
                    animationDelay: `${n * 4.5}s`,
                  }}
                />
              ))}
              <text
                x={LABEL_X}
                y={centre - 4}
                fill="var(--rr-text-2)"
                fontSize="11"
                dominantBaseline="middle"
              >
                {bucket.label}
              </text>
              <text
                x={LABEL_X}
                y={centre + 10}
                fill={TONE[bucket.id] ?? "#9ba6b4"}
                fontSize="12"
                fontWeight="500"
                dominantBaseline="middle"
                style={{ fontFamily: "var(--font-mono), monospace" }}
              >
                {`${rupees(bucket.amountPaise)} · ${bucket.events} events`}
              </text>
              <title>{`${bucket.label} — ${NOTE[bucket.id] ?? ""}`}</title>
            </g>
          );
        })}

        <rect
          x={SOURCE_X - 8}
          y={sourceTop}
          width="7"
          height={sourceHeight}
          rx="3.5"
          fill="#3395ff"
          opacity="0.85"
        />
      </svg>
    </div>
  );
}
