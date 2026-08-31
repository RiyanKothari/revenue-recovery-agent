"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Text,
  Heading,
  Badge,
  Card,
  CardBody,
  Divider,
} from "@razorpay/blade/components";

/**
 * Built on Razorpay's own Blade design system (@razorpay/blade) rather than
 * a custom theme — see docs/DESIGN-DECISIONS.md for why.
 *
 * Ledger-first, per FRONTEND-DESIGN.md: the live reasoning feed is the
 * visual anchor and the summary strip is deliberately compact above it. The
 * feed is the thing that proves this is an agent reasoning about real money,
 * which is the moment the demo is judged on — the stats are supporting
 * evidence, not the headline.
 *
 * Every number on this page comes from /api/batch-summary and
 * /api/audit-feed. Nothing is computed or invented client-side.
 */

interface BatchSummary {
  total_events: number;
  total_at_risk_paise: number;
  recovered_paise: number;
  recovery_rate: number;
  attempted_events: number;
  recovery_rate_attempted: number;
  by_root_cause: Record<string, { count: number; amount_paise: number }>;
  avg_time_to_recovery_minutes: number | null;
  timed_recoveries: number;
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

interface AuditRow {
  id: string;
  stage: string;
  detail: Record<string, unknown>;
  created_at: string;
  event: { amount_paise: number; root_cause: string; customer_id: string } | null;
}

/**
 * The UI speaks in outcomes, not internal identifiers — the raw enum belongs
 * in the audit log, not on screen. Unrecognised values fall back to a
 * humanised form of the identifier rather than a placeholder, so a new action
 * or stopping reason added later still reads correctly here without a code
 * change.
 */
function humanise(value: string): string {
  const cleaned = value.replace(/^guardrail_check_failed:/, "").replace(/[_:]+/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

const ACTION_LABELS: Record<string, string> = {
  send_retry_link_whatsapp: "Sent WhatsApp retry",
  send_retry_link_email: "Sent email retry",
  escalate_human: "Escalated to human",
};

// Executed rows name what happened, not the channel in the abstract.
const EXECUTED_LABELS: Record<string, string> = {
  whatsapp: "Sent via WhatsApp",
  email: "Sent via email",
  human_escalation: "Queued for human review",
};

const REASON_LABELS: Record<string, string> = {
  customer_dnd_opt_out: "Customer opted out (DND)",
  max_retry_attempts_reached: "Reached retry limit",
  cooldown_window_active: "Reached cooldown window",
  refund_or_dispute_flagged: "Refunded or disputed",
  not_recoverable_or_unknown_cause: "Unrecognised failure — needs review",
  agent_returned_unusable_decision: "Agent response unusable — escalated",
  negative_expected_value: "Not worth chasing (cost exceeds expected recovery)",
  no_customer_identifier: "No customer id — consent unverifiable",
  holdout_control: "Holdout control — deliberately untreated",
  experiment_assignment_failed: "Could not record experiment arm",
};

const ROOT_CAUSE_LABELS: Record<string, string> = {
  insufficient_funds: "Insufficient funds",
  bank_timeout: "Bank timeout",
  card_declined: "Card declined",
  gateway_error: "Gateway error",
  network_drop: "Network drop",
  invalid_credentials: "Invalid credentials",
  unknown: "Unknown",
  unclassified: "Unclassified",
};

/**
 * Not every stopped event is a failure. A holdout control was withheld on
 * purpose to measure the baseline, and a negative-expected-value skip is the
 * agent correctly declining to spend ₹50 chasing ₹40. Listing either under
 * "could not resolve" would misrepresent a deliberate decision as a
 * shortcoming — and understate the judgment the agent is exercising.
 */
const DELIBERATE_REASONS = new Set(["holdout_control", "negative_expected_value"]);

function label(map: Record<string, string>, key: string | undefined): string {
  if (!key) return "—";
  return map[key] ?? humanise(key);
}

/**
 * Stopping reasons need their own resolver: the guardrail failure reasons are
 * namespaced (`guardrail_check_failed:consent`), and humanising one naively
 * yields a bare "Consent" badge, which reads as a category rather than as the
 * refusal it actually was.
 */
function reasonLabel(reason: string | undefined): string {
  if (!reason) return "—";
  if (reason.startsWith("guardrail_check_failed")) {
    return "Safety check unavailable — held back";
  }
  return label(REASON_LABELS, reason);
}

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The one place motion is used for delight rather than function: the summary
 * strip tweens to its real values on arrival instead of snapping. Reduced
 * motion still gets the number, immediately.
 */
function useCountUp(target: number | null, durationMs = 600): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (target == null) return;

    if (prefersReducedMotion()) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    if (delta === 0) return;

    let frame = 0;
    const started = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return display;
}

interface Conformance {
  conformance: {
    passed: boolean;
    totalChecked: number;
    totalViolations: number;
    results: {
      id: string;
      description: string;
      severity: string;
      checked: number;
      violations: { detail: string }[];
    }[];
  };
  complianceCost: {
    basis: string;
    byCategory: Record<
      string,
      { count: number; atRiskPaise: number; foregonePaise: number }
    >;
    totalForegonePaise: number;
    note: string;
  };
}

type FeedStatus = "connecting" | "live" | "offline";

export default function DashboardPage() {
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [feed, setFeed] = useState<AuditRow[]>([]);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [conformance, setConformance] = useState<Conformance | null>(null);

  useEffect(() => {
    // A failed poll must not kill the loop — keep the last good numbers on
    // screen, mark the feed stale, and try again on the next tick.
    const load = async () => {
      try {
        const [summaryRes, feedRes] = await Promise.all([
          fetch("/api/batch-summary"),
          fetch("/api/audit-feed"),
        ]);
        if (!summaryRes.ok || !feedRes.ok) {
          setStatus("offline");
          return;
        }
        setSummary(await summaryRes.json());
        setFeed((await feedRes.json()).feed ?? []);
        setStatus("live");
      } catch {
        setStatus("offline");
      }
    };

    load();
    const interval = setInterval(load, 4000); // near-real-time; a socket is overkill for this
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Conformance re-derives every invariant across the whole batch, so it is
    // far heavier than the feed poll and runs on its own slower cadence.
    const verify = async () => {
      try {
        const res = await fetch("/api/conformance");
        if (!res.ok) return;
        setConformance(await res.json());
      } catch {
        return;
      }
    };

    verify();
    const interval = setInterval(verify, 30000);
    return () => clearInterval(interval);
  }, []);

  const reasoningRows = feed
    .filter((row) => row.stage === "agent_decided" || row.stage === "action_executed")
    .slice(0, 25);

  const allStops = summary?.exceptions ?? [];
  const unresolved = allStops.filter((e) => !DELIBERATE_REASONS.has(e.reason));
  const declined = allStops.filter((e) => DELIBERATE_REASONS.has(e.reason));

  return (
    <Box
      padding="spacing.7"
      minHeight="100vh"
      backgroundColor="surface.background.gray.subtle"
    >
      {/* --- Header --- */}
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="flex-start"
        gap="spacing.4"
        marginBottom="spacing.6"
      >
        <Box>
          <Heading size="large">Revenue Recovery — Live</Heading>
          <Text color="surface.text.gray.muted">
            Extending Razorpay Sprint 2026&apos;s failed-payment recovery pattern with
            root-cause reasoning, bounded actions, and a full audit trail.
          </Text>
        </Box>
        <StatusPill status={status} />
      </Box>

      {/* --- Summary strip: compact, top-anchored, smaller than the feed --- */}
      <Box marginBottom="spacing.7">
        <div className="rr-stats">
          <SummaryStat
            label="Total at risk"
            value={summary ? summary.total_at_risk_paise : null}
            format={rupees}
          />
          <SummaryStat
            label="Recovered"
            value={summary ? summary.recovered_paise : null}
            format={rupees}
            tone="positive"
          />
          <SummaryStat
            label="Recovery rate"
            value={summary ? summary.recovery_rate * 100 : null}
            format={(n) => `${n.toFixed(1)}%`}
            tone="positive"
            sub={
              summary
                ? `${(summary.recovery_rate_attempted * 100).toFixed(1)}% of ${summary.attempted_events} attempted`
                : undefined
            }
          />
          <SummaryStat
            label="Avg. time to recovery"
            value={summary?.avg_time_to_recovery_minutes ?? null}
            format={(n) => `${Math.round(n)} min`}
            sub={
              summary && summary.timed_recoveries > 0
                ? `across ${summary.timed_recoveries} recoveries`
                : undefined
            }
          />
        </div>
      </Box>

      {/* --- Measured lift. Everything above is attribution; this is the
          only number on the page that establishes causation. --- */}
      {summary && <LiftPanel experiment={summary.experiment} />}

      {/* --- Machine-checked safety proof. The guardrails enforce; this
          re-derives the same properties from what was recorded. --- */}
      {conformance && <ConformancePanel data={conformance} />}

      <div className="rr-columns">
        {/* --- Live reasoning feed (the anchor) --- */}
        <Box>
          <span className="rr-mono">
            <Heading size="small" marginBottom="spacing.3">
              LIVE REASONING
            </Heading>
          </span>

          {reasoningRows.length === 0 ? (
            <Card>
              <CardBody>
                <Text color="surface.text.gray.muted">
                  No revenue-at-risk events yet — send a test payment failure to see the
                  agent respond.
                </Text>
              </CardBody>
            </Card>
          ) : (
            <div className="rr-scroll">
              <Box display="flex" flexDirection="column" gap="spacing.3">
                {reasoningRows.map((row) => (
                  <FeedEntry key={row.id} row={row} />
                ))}
              </Box>
            </div>
          )}
        </Box>

        {/* --- Root cause breakdown + exceptions --- */}
        <Box>
          <span className="rr-mono">
            <Heading size="small" marginBottom="spacing.3">
              BY ROOT CAUSE
            </Heading>
          </span>
          <Box display="flex" flexDirection="column" gap="spacing.3" marginBottom="spacing.6">
            {summary && Object.keys(summary.by_root_cause).length > 0 ? (
              Object.entries(summary.by_root_cause)
                .sort((a, b) => b[1].amount_paise - a[1].amount_paise)
                .map(([cause, stats]) => (
                  <Box key={cause} display="flex" justifyContent="space-between" gap="spacing.3">
                    <Text>{label(ROOT_CAUSE_LABELS, cause)}</Text>
                    <span className="rr-mono">
                      <Text color="surface.text.gray.muted">
                        {`${stats.count} · ${rupees(stats.amount_paise)}`}
                      </Text>
                    </span>
                  </Box>
                ))
            ) : (
              <Text color="surface.text.gray.muted">Nothing classified yet.</Text>
            )}
          </Box>

          <Divider marginBottom="spacing.5" />

          {/* An honest exceptions list is more credible than a suspiciously
              perfect dashboard — this is deliberately not tucked away. */}
          <span className="rr-mono">
            <Heading size="small" marginBottom="spacing.3">
              EXCEPTIONS — COULD NOT RESOLVE
            </Heading>
          </span>
          <Box display="flex" flexDirection="column" gap="spacing.3">
            {unresolved.length ? (
              unresolved.slice(0, 20).map((exc, i) => (
                <Box
                  key={`${exc.revenue_event_id}-${i}`}
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                  gap="spacing.3"
                >
                  <span className="rr-mono">
                    <Text size="small" color="surface.text.gray.muted">
                      {exc.revenue_event_id.slice(0, 8)}
                    </Text>
                  </span>
                  <Badge color="negative">{reasonLabel(exc.reason)}</Badge>
                </Box>
              ))
            ) : (
              <Text color="surface.text.gray.muted">No unresolved exceptions yet.</Text>
            )}
          </Box>

          {/* Deliberate non-actions, kept separate from failures — declining
              to act is judgment, not a shortcoming. */}
          {declined.length > 0 && (
            <>
              <Divider marginTop="spacing.5" marginBottom="spacing.5" />
              <span className="rr-mono">
                <Heading size="small" marginBottom="spacing.3">
                  DECLINED ON PURPOSE
                </Heading>
              </span>
              <Box display="flex" flexDirection="column" gap="spacing.3">
                {declined.slice(0, 20).map((exc, i) => (
                  <Box
                    key={`${exc.revenue_event_id}-${i}`}
                    display="flex"
                    justifyContent="space-between"
                    alignItems="center"
                    gap="spacing.3"
                  >
                    <span className="rr-mono">
                      <Text size="small" color="surface.text.gray.muted">
                        {exc.revenue_event_id.slice(0, 8)}
                      </Text>
                    </span>
                    <Badge color="information">{reasonLabel(exc.reason)}</Badge>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Box>
      </div>
    </Box>
  );
}

/**
 * The holdout result. A slice of eligible events was deliberately left
 * untreated, so this compares "agent acted" against "agent did nothing" on
 * comparable populations — the difference is recovery the agent caused,
 * rather than recovery that merely followed a message being sent.
 */
function LiftPanel({
  experiment,
}: {
  experiment: BatchSummary["experiment"];
}) {
  const { treated, control, lift } = experiment;
  const hasArms = treated.n > 0 && control.n > 0;

  return (
    <Card marginBottom="spacing.7">
      <CardBody>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          gap="spacing.3"
          marginBottom="spacing.4"
        >
          <span className="rr-mono">
            <Heading size="small">MEASURED LIFT vs HOLDOUT</Heading>
          </span>
          <Badge color={lift.significant ? "positive" : "neutral"}>
            {lift.significant ? "Significant" : "Not yet conclusive"}
          </Badge>
        </Box>

        {!hasArms ? (
          <Text color="surface.text.gray.muted">
            {`No holdout data yet — ${experiment.holdout_percent}% of eligible events are withheld to measure the do-nothing baseline.`}
          </Text>
        ) : (
          <>
            <Box display="flex" flexWrap="wrap" gap="spacing.7" marginBottom="spacing.4">
              <ArmStat
                label="Treated (agent acted)"
                rate={lift.treatedRate}
                arm={treated}
              />
              <ArmStat
                label="Control (left alone)"
                rate={lift.controlRate}
                arm={control}
              />
              <Box>
                <Text size="small" color="surface.text.gray.muted">
                  Incremental recovery
                </Text>
                <Heading size="medium" color="feedback.text.positive.intense">
                  {lift.incrementalPaise == null
                    ? "—"
                    : rupees(lift.incrementalPaise)}
                </Heading>
                <Text size="xsmall" color="surface.text.gray.muted">
                  {`${lift.absoluteLiftPp >= 0 ? "+" : ""}${lift.absoluteLiftPp.toFixed(1)}pp${
                    lift.ci95Pp
                      ? ` (95% CI ${lift.ci95Pp[0].toFixed(1)} to ${lift.ci95Pp[1].toFixed(1)})`
                      : ""
                  }`}
                </Text>
              </Box>
            </Box>

            <Text size="small" color="surface.text.gray.muted">
              {lift.caveat ??
                "Recovery the agent caused, over what these events would have returned untouched."}
            </Text>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function ArmStat({
  label,
  rate,
  arm,
}: {
  label: string;
  rate: number;
  arm: { n: number; converted: number };
}) {
  return (
    <Box>
      <Text size="small" color="surface.text.gray.muted">
        {label}
      </Text>
      <Heading size="medium">{`${(rate * 100).toFixed(1)}%`}</Heading>
      <span className="rr-mono">
        <Text size="xsmall" color="surface.text.gray.muted">
          {`${arm.converted} / ${arm.n}`}
        </Text>
      </span>
    </Box>
  );
}

const COST_CATEGORY_LABELS: Record<string, string> = {
  compliance: "Compliance rules",
  measurement: "Holdout (price of knowing)",
  economics: "Not worth chasing",
  degraded: "Safety check unavailable",
  unrecoverable: "Nothing to chase",
};

/**
 * Safety, proven and priced.
 *
 * The left half is a mechanical re-derivation of each invariant from the
 * recorded data — not a restatement of what the guardrails intended, but a
 * check that they actually held. The right half is what those rules cost in
 * foregone recovery, because safety isn't free and saying so is more credible
 * than implying it is.
 */
function ConformancePanel({ data }: { data: Conformance }) {
  const { conformance, complianceCost } = data;

  return (
    <Card marginBottom="spacing.7">
      <CardBody>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          gap="spacing.3"
          marginBottom="spacing.4"
        >
          <span className="rr-mono">
            <Heading size="small">SAFETY CONFORMANCE</Heading>
          </span>
          <Badge color={conformance.passed ? "positive" : "negative"}>
            {conformance.passed
              ? `All invariants held · ${conformance.totalChecked} checks`
              : `${conformance.totalViolations} violation(s)`}
          </Badge>
        </Box>

        <div className="rr-columns">
          <Box display="flex" flexDirection="column" gap="spacing.2">
            {conformance.results.map((result) => {
              const ok = result.violations.length === 0;
              return (
                <Box
                  key={result.id}
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                  gap="spacing.3"
                >
                  <Box display="flex" alignItems="center" gap="spacing.3">
                    <span className="rr-mono">
                      <Text size="small" color="surface.text.gray.muted">
                        {result.id}
                      </Text>
                    </span>
                    <Text size="small">{result.description}</Text>
                  </Box>
                  <Badge color={ok ? "positive" : "negative"}>
                    {ok ? `${result.checked} ok` : `${result.violations.length} failed`}
                  </Badge>
                </Box>
              );
            })}
          </Box>

          <Box>
            <Text size="small" color="surface.text.gray.muted" marginBottom="spacing.3">
              What the rules cost (estimated)
            </Text>
            <Box display="flex" flexDirection="column" gap="spacing.2">
              {Object.entries(complianceCost.byCategory)
                .filter(([, line]) => line.count > 0)
                .map(([category, line]) => (
                  <Box
                    key={category}
                    display="flex"
                    justifyContent="space-between"
                    gap="spacing.3"
                  >
                    <Text size="small">
                      {label(COST_CATEGORY_LABELS, category)}
                    </Text>
                    <span className="rr-mono">
                      <Text size="small" color="surface.text.gray.muted">
                        {`${line.count} · ${rupees(line.foregonePaise)}`}
                      </Text>
                    </span>
                  </Box>
                ))}
            </Box>

            <Box marginTop="spacing.4">
              <Heading size="medium">{rupees(complianceCost.totalForegonePaise)}</Heading>
              <Text size="xsmall" color="surface.text.gray.muted">
                Recovery foregone to keep the rules — estimated, not measured.
              </Text>
            </Box>
          </Box>
        </div>
      </CardBody>
    </Card>
  );
}

function StatusPill({ status }: { status: FeedStatus }) {
  const config = {
    live: { color: "positive" as const, text: "Live", dot: "#00A868" },
    connecting: { color: "neutral" as const, text: "Connecting", dot: "#8B8B8B" },
    offline: { color: "negative" as const, text: "Feed unavailable", dot: "#D93B3B" },
  }[status];

  // Badge takes text-only children, so the dot sits beside it rather than
  // inside. Colour never carries the meaning alone — the label says it too.
  return (
    <Box display="flex" alignItems="center" gap="spacing.2">
      <span
        className="rr-live-dot"
        style={{ backgroundColor: config.dot }}
        aria-hidden="true"
      />
      <Badge color={config.color}>{config.text}</Badge>
    </Box>
  );
}

function FeedEntry({ row }: { row: AuditRow }) {
  const detail = row.detail as Record<string, any>;
  const executed = row.stage === "action_executed";

  // action_executed rows carry a channel; agent_decided rows carry the action.
  const actionText = executed
    ? label(EXECUTED_LABELS, detail?.channel)
    : label(ACTION_LABELS, detail?.action);

  const failed = executed && detail?.delivery_success === false;

  // The MCP-issued payment link is the verifiable Razorpay-side artifact of
  // the action — worth surfacing rather than leaving in the audit log.
  const paymentLinkId = detail?.payment_link_id as string | undefined;

  return (
    <div className="rr-feed-row">
      <Card>
        <CardBody>
          <Box
            display="flex"
            justifyContent="space-between"
            alignItems="center"
            gap="spacing.3"
            marginBottom="spacing.2"
          >
            <Badge color={failed ? "negative" : executed ? "positive" : "information"}>
              {failed ? `${actionText} — delivery failed` : actionText}
            </Badge>
            <span className="rr-mono">
              <Text size="small" color="surface.text.gray.muted">
                {new Date(row.created_at).toLocaleTimeString("en-IN", { hour12: false })}
              </Text>
            </span>
          </Box>

          {row.event && (
            <Box display="flex" gap="spacing.2" marginBottom="spacing.2">
              <Text size="small" color="surface.text.gray.muted">
                {label(ROOT_CAUSE_LABELS, row.event.root_cause)}
              </Text>
              <span className="rr-mono">
                <Text size="small" color="surface.text.gray.muted">
                  {rupees(row.event.amount_paise)}
                </Text>
              </span>
            </Box>
          )}

          {/* The rationale is the explainability artifact — it is the reason
              this panel exists, so it gets the body treatment, not a caption. */}
          {detail?.rationale ? (
            <Text>{detail.rationale}</Text>
          ) : detail?.note ? (
            <Text color="surface.text.gray.muted">{detail.note}</Text>
          ) : detail?.error ? (
            <Text color="surface.text.gray.muted">
              {humanise(String(detail.error))}
            </Text>
          ) : paymentLinkId ? (
            <span className="rr-mono">
              <Text size="small" color="surface.text.gray.muted">
                {paymentLinkId}
              </Text>
            </span>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function SummaryStat({
  label: statLabel,
  value,
  format,
  tone,
  sub,
}: {
  label: string;
  value: number | null;
  format: (n: number) => string;
  tone?: "positive";
  sub?: string;
}) {
  const animated = useCountUp(value);

  return (
    <Card>
      <CardBody>
        <Text size="small" color="surface.text.gray.muted">
          {statLabel}
        </Text>
        <Heading
          size="medium"
          color={tone === "positive" ? "feedback.text.positive.intense" : undefined}
        >
          {value == null ? "—" : format(animated)}
        </Heading>
        {sub && (
          <Text size="xsmall" color="surface.text.gray.muted">
            {sub}
          </Text>
        )}
      </CardBody>
    </Card>
  );
}
