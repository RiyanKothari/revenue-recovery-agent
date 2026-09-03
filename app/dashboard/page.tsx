"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MoneyRiver, type Bucket } from "./money-river";
import {
  ACTION_LABELS,
  Chip,
  DELIBERATE_REASONS,
  EXECUTED_LABELS,
  Header,
  ROOT_CAUSE_LABELS,
  SectionTitle,
  Stat,
  duration,
  humanise,
  label,
  reasonLabel,
  rupees,
  type FeedStatus,
} from "./ui";

/**
 * The Desk — the live operations view.
 *
 * Ledger-first: the reasoning feed is the anchor and everything else is
 * supporting evidence. The feed is what proves this is an agent reasoning
 * about real money, which is the thing the demo is judged on; the summary
 * numbers are the context that makes it legible.
 *
 * Every figure comes from /api/batch-summary, /api/audit-feed,
 * /api/conformance and /api/cache-stats. Nothing is computed client-side
 * beyond formatting, and nothing is invented.
 */

interface Summary {
  total_events: number;
  total_at_risk_paise: number;
  recovered_paise: number;
  recovery_rate: number;
  attempted_events: number;
  recovery_rate_attempted: number;
  by_root_cause: Record<string, { count: number; amount_paise: number }>;
  avg_time_to_recovery_minutes: number | null;
  timed_recoveries: number;
  synthetic_events: number;
  outcome_buckets: Bucket[];
  exceptions: { revenue_event_id: string; reason: string }[];
  experiment: {
    policy_version: string;
    holdout_percent: number;
    treated: { n: number; converted: number; recoveredPaise: number };
    control: { n: number; converted: number; recoveredPaise: number };
    lift: {
      treatedRate: number;
      controlRate: number;
      absoluteLiftPp: number;
      ci95Pp: [number, number] | null;
      incrementalPaise: number | null;
      significant: boolean;
      caveat?: string;
    };
  };
}

interface FeedRow {
  id: string;
  revenue_event_id: string;
  stage: string;
  detail: Record<string, any>;
  created_at: string;
  event: { amount_paise: number; root_cause: string | null; customer_id: string | null } | null;
}

interface Conformance {
  conformance: {
    passed: boolean;
    totalChecked: number;
    totalViolations: number;
    results: { id: string; description: string; checked: number; violations: { detail: string }[] }[];
  };
  complianceCost: {
    byCategory: Record<string, { count: number; atRiskPaise: number; foregonePaise: number }>;
    totalForegonePaise: number;
  };
}

interface CacheStats {
  distinctSituations: number;
  modelCalls: number;
  reusedDecisions: number;
  totalDecisions: number;
  reuseRate: number;
  situations: { key: string; description: string; served: number }[];
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [conformance, setConformance] = useState<Conformance | null>(null);
  const [cache, setCache] = useState<CacheStats | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    // A failed poll must not clear the screen. Keep the last good numbers,
    // mark the feed stale, and try again — an outage should look like
    // staleness, not like an agent that has done nothing.
    const load = async () => {
      try {
        const [s, f] = await Promise.all([
          fetch("/api/batch-summary"),
          fetch("/api/audit-feed"),
        ]);
        if (!s.ok || !f.ok) {
          setStatus("offline");
          return;
        }
        setSummary(await s.json());
        setFeed((await f.json()).feed ?? []);
        setStatus("live");
      } catch {
        setStatus("offline");
      }
    };

    load();
    if (paused) return;
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [paused]);

  useEffect(() => {
    // Conformance re-derives every invariant across the whole batch, so it is
    // far heavier than the feed poll and runs on its own slower cadence.
    const verify = async () => {
      try {
        const [c, k] = await Promise.all([fetch("/api/conformance"), fetch("/api/cache-stats")]);
        if (c.ok) setConformance(await c.json());
        if (k.ok) setCache(await k.json());
      } catch {
        /* keep the last good result */
      }
    };
    verify();
    const interval = setInterval(verify, 30000);
    return () => clearInterval(interval);
  }, []);

  const rows = feed
    .filter((r) => r.stage === "agent_decided" || r.stage === "action_executed")
    .slice(0, 40);

  const stops = summary?.exceptions ?? [];
  const unresolved = stops.filter((e) => !DELIBERATE_REASONS.has(e.reason));
  const declined = stops.filter((e) => DELIBERATE_REASONS.has(e.reason));

  return (
    <div className="rr-page">
      <Header status={status} />

      <div className="rr-shell">
        <MoneyRiver
          buckets={summary?.outcome_buckets ?? []}
          totalAtRiskPaise={summary?.total_at_risk_paise ?? 0}
        />

        {/* The provenance of every number below. Deliberately not tucked
            away: this project's thesis is separating measured from
            estimated, and a dashboard that hides its own provenance
            forfeits that argument at the first hard question. */}
        {summary && summary.synthetic_events > 0 && (
          <div className="rr-notice">
            <span aria-hidden="true">⚠</span>
            <span>
              <strong>Synthetic batch</strong> — {summary.synthetic_events} of{" "}
              {summary.total_events} events are seeded. Recoveries are simulated from a
              stated assumption, so the lift below demonstrates the measurement working;
              it is not evidence about real customers.
            </span>
          </div>
        )}

        <div className="rr-stats">
          <Stat
            label="Total risk base"
            value={summary ? summary.total_at_risk_paise : null}
            format={rupees}
            rail="var(--rr-blue)"
            sub={summary ? `${summary.total_events} failed payments` : undefined}
          />
          <Stat
            label="Recovered"
            value={summary ? summary.recovered_paise : null}
            format={rupees}
            rail="var(--rr-green)"
            sub={
              summary
                ? `${summary.experiment.treated.converted + summary.experiment.control.converted} payments came back`
                : undefined
            }
          />
          <Stat
            label="Recovery rate"
            value={summary ? summary.recovery_rate * 100 : null}
            format={(n) => `${n.toFixed(1)}%`}
            rail="var(--rr-amber)"
            sub={
              summary
                ? `${(summary.recovery_rate_attempted * 100).toFixed(1)}% of ${summary.attempted_events} attempted`
                : undefined
            }
          />
          <Stat
            label="Avg resolution time"
            value={summary?.avg_time_to_recovery_minutes ?? null}
            format={duration}
            rail="var(--rr-neutral)"
            sub={
              summary && summary.timed_recoveries > 0
                ? `across ${summary.timed_recoveries} recoveries`
                : undefined
            }
          />
        </div>

        <div className="rr-columns">
          <div>
            <div className="rr-card" style={{ padding: 16 }}>
              <SectionTitle
                right={
                  <button
                    className="rr-chip rr-chip--neutral"
                    style={{ cursor: "pointer" }}
                    onClick={() => setPaused((p) => !p)}
                    aria-pressed={paused}
                    aria-label={paused ? "Resume the live feed" : "Pause the live feed"}
                  >
                    {paused ? "Resume" : "Pause"}
                  </button>
                }
              >
                Live reasoning
              </SectionTitle>

              {rows.length === 0 ? (
                <div style={{ color: "var(--rr-text-3)", fontSize: 13, padding: "16px 4px" }}>
                  No revenue-at-risk events yet — send a test payment failure to see the
                  agent respond.
                </div>
              ) : (
                /**
                 * Polite, never assertive. This region updates every few
                 * seconds, and an assertive live region would interrupt a
                 * screen reader on each poll — making the most important
                 * panel on the page the reason someone cannot use it.
                 */
                <div className="rr-feed" aria-live="polite" aria-atomic="false">
                  {rows.map((row) => (
                    <FeedRowCard key={row.id} row={row} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rr-rail">
            {summary && <LiftCard experiment={summary.experiment} />}
            {conformance && <ConformanceCard data={conformance} />}
            {conformance && <RulesCostCard data={conformance} />}
            {cache && <CacheCard stats={cache} />}
            {summary && <RootCauseCard byCause={summary.by_root_cause} />}
            <ExceptionsCard unresolved={unresolved} declined={declined} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One ledger entry. The whole row is a link to the trace, because the
 * natural question on reading a rationale is "show me how it got there".
 */
function FeedRowCard({ row }: { row: FeedRow }) {
  const executed = row.stage === "action_executed";
  const failed = executed && row.detail?.delivery_success === false;

  const actionText = executed
    ? label(EXECUTED_LABELS, row.detail?.channel)
    : label(ACTION_LABELS, row.detail?.action);

  // Reused reasoning is labelled rather than passed off as fresh. The
  // rationale is identical because the situation is identical, but the feed
  // must never imply the agent thought about this event from scratch.
  const fromCache = row.detail?.from_cache === true;

  // Razorpay test mode allows 30 payment links in total, so a large demo
  // batch exhausts them. Past that the pipeline still runs and the link is
  // marked simulated — shown here rather than left to look like a real one.
  const simulatedLink = row.detail?.link_source === "simulated";

  const rail = failed
    ? "var(--rr-red)"
    : executed
      ? "var(--rr-green)"
      : fromCache
        ? "var(--rr-neutral)"
        : "var(--rr-blue)";

  return (
    <Link
      href={`/dashboard/event/${row.revenue_event_id}`}
      className="rr-row"
      style={{ ["--rail" as string]: rail }}
    >
      <div className="rr-row__top">
        <span className="rr-row__id rr-mono">
          {row.revenue_event_id.slice(0, 8).toUpperCase()}
        </span>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {fromCache && <Chip tone="neutral">reused</Chip>}
          {simulatedLink && <Chip tone="amber">simulated link</Chip>}
          <Chip tone={failed ? "red" : executed ? "green" : "blue"}>
            {failed ? `${actionText} — failed` : actionText}
          </Chip>
        </span>
      </div>

      <div className="rr-row__amount rr-mono">
        {row.event ? rupees(row.event.amount_paise) : "—"}
        {row.event?.root_cause && (
          <span style={{ fontSize: 11, color: "var(--rr-text-3)", marginLeft: 8 }}>
            {label(ROOT_CAUSE_LABELS, row.event.root_cause)}
          </span>
        )}
      </div>

      <div className="rr-row__why">
        {row.detail?.rationale ??
          row.detail?.note ??
          (row.detail?.error ? humanise(String(row.detail.error)) : "—")}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 10,
          color: "var(--rr-text-3)",
        }}
        className="rr-mono"
      >
        <span>{row.detail?.payment_link_id ?? ""}</span>
        <span>{new Date(row.created_at).toLocaleTimeString("en-IN", { hour12: false })}</span>
      </div>
    </Link>
  );
}

/**
 * The holdout result — the only number on this page that establishes
 * causation rather than attribution.
 */
function LiftCard({ experiment }: { experiment: Summary["experiment"] }) {
  const { treated, control, lift } = experiment;
  const hasArms = treated.n > 0 && control.n > 0;

  return (
    <div className="rr-card">
      <SectionTitle
        right={
          lift.incrementalPaise != null && hasArms ? (
            <Chip tone={lift.significant ? "green" : "neutral"}>
              {`Inc. ${rupees(lift.incrementalPaise)}`}
            </Chip>
          ) : undefined
        }
      >
        Measured lift vs holdout
      </SectionTitle>

      {!hasArms ? (
        <div style={{ fontSize: 12.5, color: "var(--rr-text-2)" }}>
          {`No holdout data yet — ${experiment.holdout_percent}% of eligible events are withheld to measure the do-nothing baseline.`}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div className="rr-bar">
                <div
                  className="rr-bar__fill rr-bar__fill--treated"
                  style={{ width: `${Math.min(100, lift.treatedRate * 100)}%` }}
                />
                <span className="rr-bar__label">
                  Treated · {(lift.treatedRate * 100).toFixed(1)}%
                </span>
              </div>
              <div
                className="rr-mono"
                style={{ fontSize: 10, color: "var(--rr-text-3)", marginTop: 3 }}
              >
                {treated.converted} / {treated.n} recovered
              </div>
            </div>

            <div>
              <div className="rr-bar">
                <div
                  className="rr-bar__fill rr-bar__fill--control"
                  style={{ width: `${Math.min(100, lift.controlRate * 100)}%` }}
                />
                <span className="rr-bar__label">
                  Holdout · {(lift.controlRate * 100).toFixed(1)}%
                </span>
              </div>
              <div
                className="rr-mono"
                style={{ fontSize: 10, color: "var(--rr-text-3)", marginTop: 3 }}
              >
                {control.converted} / {control.n} recovered
              </div>
            </div>
          </div>

          {/* The interval is drawn to scale, not printed as a footnote. Its
              width is the honest part of this panel — a lift with a wide
              interval is a weaker claim, and the reader should see that
              before they read the point estimate. */}
          {lift.ci95Pp && <ConfidenceInterval ci={lift.ci95Pp} point={lift.absoluteLiftPp} />}

          <div style={{ fontSize: 11.5, color: "var(--rr-text-2)", marginTop: 10 }}>
            {lift.caveat ??
              "Recovery the agent caused, over what these events would have returned untouched."}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The interval, drawn against zero.
 *
 * The zero line is the point of the widget. "Significant" means the whole
 * interval sits above it, and showing that is a far stronger claim than
 * printing a p-value or a badge — a reader can check it themselves in one
 * glance. An interval that straddles zero should look like it straddles
 * zero, which is exactly the case a coloured "significant" chip alone would
 * let you skim past.
 *
 * Labels are positioned under the marks they name rather than spread across
 * the axis, because an interval sitting in the right-hand third with its
 * bounds printed at the far edges reads as a wider interval than it is.
 */
function ConfidenceInterval({ ci, point }: { ci: [number, number]; point: number }) {
  // Symmetric around zero so the distance from zero is honest in both
  // directions, with headroom so the marks never touch the edge.
  const bound = Math.max(5, Math.abs(ci[0]), Math.abs(ci[1]), Math.abs(point)) * 1.25;
  const pos = (v: number) => ((v + bound) / (2 * bound)) * 100;

  const clear = ci[0] > 0 || ci[1] < 0;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="rr-ci" style={{ height: 26 }}>
        <div className="rr-ci__track" />

        {/* Zero. Everything about this widget is a comparison to it. */}
        <div
          style={{
            position: "absolute",
            left: `${pos(0)}%`,
            top: 2,
            bottom: 8,
            width: 1,
            background: "var(--rr-border-strong)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${pos(0)}%`,
            top: 0,
            fontSize: 9,
            color: "var(--rr-text-3)",
            transform: "translateX(-50%)",
          }}
        >
          0
        </div>

        <div
          className="rr-ci__span"
          style={{ left: `${pos(ci[0])}%`, width: `${pos(ci[1]) - pos(ci[0])}%` }}
        />
        <div className="rr-ci__point" style={{ left: `${pos(point)}%` }} />

        <span
          className="rr-mono"
          style={{
            position: "absolute",
            left: `${pos(point)}%`,
            top: 15,
            transform: "translateX(-50%)",
            fontSize: 10,
            color: "var(--rr-blue)",
            whiteSpace: "nowrap",
          }}
        >
          {`${point >= 0 ? "+" : ""}${point.toFixed(1)}pp`}
        </span>
      </div>

      <div
        className="rr-mono"
        style={{ fontSize: 9.5, color: "var(--rr-text-3)", marginTop: 12 }}
      >
        {`95% CI ${ci[0].toFixed(1)} to ${ci[1].toFixed(1)}pp`}
        {clear
          ? " — the whole interval is clear of zero"
          : " — the interval crosses zero, so the effect is not yet established"}
      </div>
    </div>
  );
}

function ConformanceCard({ data }: { data: Conformance }) {
  const { conformance } = data;

  return (
    <div className="rr-card">
      <SectionTitle
        right={
          <Chip tone={conformance.passed ? "green" : "red"}>
            {conformance.passed
              ? `${conformance.totalChecked.toLocaleString("en-IN")} checks`
              : `${conformance.totalViolations} violation(s)`}
          </Chip>
        }
      >
        Safety conformance
      </SectionTitle>

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {conformance.results.map((r) => {
          const ok = r.violations.length === 0;
          return (
            <div
              key={r.id}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
            >
              <span
                className="rr-mono"
                style={{ color: "var(--rr-text-3)", width: 20, flexShrink: 0 }}
              >
                {r.id}
              </span>
              <span style={{ color: "var(--rr-text-2)", flex: 1 }}>{r.description}</span>
              <Chip tone={ok ? "green" : "red"}>
                {ok ? `${r.checked} ok` : `${r.violations.length} failed`}
              </Chip>
            </div>
          );
        })}
      </div>

      {/* The panel's entire argument. Without this line a reader sees seven
          green boxes and reads decoration. */}
      <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginTop: 12, lineHeight: 1.5 }}>
        Re-derived from the recorded data by a verifier that shares no code with the
        guardrails that enforce it.
      </div>
    </div>
  );
}

const COST_LABELS: Record<string, string> = {
  compliance: "Compliance rules",
  measurement: "Holdout (price of knowing)",
  economics: "Not worth chasing",
  degraded: "Safety check unavailable",
  unrecoverable: "Nothing to chase",
};

/** Safety isn't free, and saying so is more credible than implying it is. */
function RulesCostCard({ data }: { data: Conformance }) {
  const lines = Object.entries(data.complianceCost.byCategory).filter(([, l]) => l.count > 0);

  return (
    <div className="rr-card">
      <SectionTitle right={<span style={{ fontSize: 10, color: "var(--rr-text-3)" }}>estimated</span>}>
        What the rules cost
      </SectionTitle>

      {lines.map(([category, line]) => (
        <div key={category} className="rr-line">
          <span className="rr-line__label">{label(COST_LABELS, category)}</span>
          <span className="rr-line__value rr-mono">
            {line.count} · {rupees(line.foregonePaise)}
          </span>
        </div>
      ))}

      <div className="rr-total">
        <div style={{ fontSize: 20, fontWeight: 500 }} className="rr-mono">
          {rupees(data.complianceCost.totalForegonePaise)}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--rr-text-3)", marginTop: 3 }}>
          Recovery foregone to keep the rules — estimated, not measured.
        </div>
      </div>
    </div>
  );
}

/**
 * The memoisation result. This is the answer to "does this scale", given as
 * a measurement rather than an assertion.
 */
function CacheCard({ stats }: { stats: CacheStats }) {
  const top = stats.situations.slice(0, 14);
  const max = Math.max(1, ...top.map((s) => s.served));

  return (
    <div className="rr-card">
      <SectionTitle
        right={<Chip tone="blue">{`${(stats.reuseRate * 100).toFixed(0)}% reused`}</Chip>}
      >
        Decision reuse
      </SectionTitle>

      <div className="rr-mono" style={{ fontSize: 15, marginBottom: 4 }}>
        {stats.modelCalls} model calls → {stats.totalDecisions} decisions
      </div>
      <div style={{ fontSize: 11, color: "var(--rr-text-3)", marginBottom: 12 }}>
        {stats.distinctSituations} genuinely distinct situations in this batch
      </div>

      <div className="rr-constellation">
        {top.map((s) => {
          const size = 16 + Math.round((s.served / max) * 26);
          return (
            <span
              key={s.key}
              className="rr-node"
              style={{ width: size, height: size }}
              title={`${s.description} — ${s.served} events`}
            >
              {size > 28 ? s.served : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RootCauseCard({
  byCause,
}: {
  byCause: Record<string, { count: number; amount_paise: number }>;
}) {
  const entries = Object.entries(byCause).sort((a, b) => b[1].amount_paise - a[1].amount_paise);
  const max = Math.max(1, ...entries.map(([, s]) => s.amount_paise));

  return (
    <div className="rr-card">
      <SectionTitle>By root cause</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {entries.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--rr-text-3)" }}>Nothing classified yet.</span>
        )}
        {entries.map(([cause, stats]) => (
          <div key={cause} className="rr-cause">
            <div
              className="rr-cause__fill"
              style={{ width: `${(stats.amount_paise / max) * 100}%` }}
            />
            <span>{label(ROOT_CAUSE_LABELS, cause)}</span>
            <span className="rr-mono" style={{ color: "var(--rr-text-2)" }}>
              {stats.count} · {rupees(stats.amount_paise)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Two lists, deliberately separate. A holdout control and a negative-EV skip
 * are the agent exercising judgment; filing them under failures would
 * present the system's best behaviour as its worst.
 */
function ExceptionsCard({
  unresolved,
  declined,
}: {
  unresolved: { revenue_event_id: string; reason: string }[];
  declined: { revenue_event_id: string; reason: string }[];
}) {
  const render = (
    items: { revenue_event_id: string; reason: string }[],
    tone: "red" | "blue"
  ) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {items.slice(0, 8).map((e, i) => (
        <Link
          key={`${e.revenue_event_id}-${i}`}
          href={`/dashboard/event/${e.revenue_event_id}`}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            textDecoration: "none",
          }}
        >
          <span className="rr-mono" style={{ fontSize: 11, color: "var(--rr-text-3)" }}>
            {e.revenue_event_id.slice(0, 8).toUpperCase()}
          </span>
          <Chip tone={tone}>{reasonLabel(e.reason)}</Chip>
        </Link>
      ))}
      {items.length > 8 && (
        <span style={{ fontSize: 10.5, color: "var(--rr-text-3)" }}>
          +{items.length - 8} more
        </span>
      )}
    </div>
  );

  return (
    <div className="rr-card">
      <SectionTitle>Exceptions — could not resolve</SectionTitle>
      {unresolved.length ? (
        render(unresolved, "red")
      ) : (
        <span style={{ fontSize: 12, color: "var(--rr-text-3)" }}>
          No unresolved exceptions.
        </span>
      )}

      {declined.length > 0 && (
        <>
          <div style={{ height: 1, background: "var(--rr-border)", margin: "14px 0" }} />
          <SectionTitle>Declined on purpose</SectionTitle>
          {render(declined, "blue")}
        </>
      )}
    </div>
  );
}
