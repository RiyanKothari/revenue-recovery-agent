"use client";

import { useEffect, useState } from "react";
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
 * Built on Razorpay's own Blade design system (@razorpay/blade) rather
 * than a custom theme — see docs/DESIGN-DECISIONS.md for why. If a
 * specific component name below doesn't match the installed Blade
 * version, check https://blade.razorpay.com/ for the current export —
 * Blade's API surface moves, this file targets 12.x.
 *
 * Three panels, matching the blueprint's dashboard spec exactly:
 *   1. Batch summary — the measured numbers the submission bar asks for
 *   2. Live reasoning feed — the agent "thinking out loud," the demo's hero moment
 *   3. Exceptions — an honest list of what the agent could NOT resolve
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
  exceptions: { revenue_event_id: string; reason: string }[];
}

interface AuditRow {
  id: string;
  stage: string;
  detail: Record<string, unknown>;
  created_at: string;
  event: { amount_paise: number; root_cause: string; customer_id: string } | null;
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [feed, setFeed] = useState<AuditRow[]>([]);

  useEffect(() => {
    // A failed poll must not kill the loop — keep the last good numbers on
    // screen and try again on the next tick.
    const load = async () => {
      try {
        const [summaryRes, feedRes] = await Promise.all([
          fetch("/api/batch-summary"),
          fetch("/api/audit-feed"),
        ]);
        if (!summaryRes.ok || !feedRes.ok) return;
        setSummary(await summaryRes.json());
        setFeed((await feedRes.json()).feed ?? []);
      } catch {
        return;
      }
    };
    load();
    const interval = setInterval(load, 4000); // near-real-time, not websocket — good enough for a demo
    return () => clearInterval(interval);
  }, []);

  return (
    <Box padding="spacing.6" backgroundColor="surface.background.gray.subtle">
      <Heading size="large">Revenue Recovery — Live</Heading>
      <Text color="surface.text.gray.muted" marginBottom="spacing.6">
        Extending Razorpay Sprint 2026's failed-payment recovery pattern with root-cause
        reasoning, bounded actions, and a full audit trail.
      </Text>

      {/* --- Batch Summary --- */}
      <Box display="flex" flexWrap="wrap" gap="spacing.4" marginBottom="spacing.6">
        <SummaryStat label="Total at risk" value={summary ? rupees(summary.total_at_risk_paise) : "—"} />
        <SummaryStat
          label="Recovered"
          value={summary ? rupees(summary.recovered_paise) : "—"}
          tone="positive"
        />
        <SummaryStat
          label="Recovery rate"
          value={summary ? `${(summary.recovery_rate * 100).toFixed(1)}%` : "—"}
          tone="positive"
        />
        {/* Of the events the agent actually acted on — excludes unknown root
            causes routed straight to human review, which it never attempted. */}
        <SummaryStat
          label="Of attempted"
          value={
            summary
              ? `${(summary.recovery_rate_attempted * 100).toFixed(1)}% of ${summary.attempted_events}`
              : "—"
          }
          tone="positive"
        />
        <SummaryStat
          label="Avg. time to recovery"
          value={
            summary?.avg_time_to_recovery_minutes != null
              ? `${Math.round(summary.avg_time_to_recovery_minutes)} min`
              : "—"
          }
        />
      </Box>

      <Box display="flex" gap="spacing.6" flexWrap="wrap">
        {/* --- Live Reasoning Feed --- */}
        <Box flex="1" minWidth="360px">
          <Heading size="small" marginBottom="spacing.3">
            Live agent reasoning
          </Heading>
          <Box display="flex" flexDirection="column" gap="spacing.3">
            {feed
              .filter((row) => row.stage === "agent_decided" || row.stage === "action_executed")
              .slice(0, 20)
              .map((row) => (
                <Card key={row.id}>
                  <CardBody>
                    <Box display="flex" justifyContent="space-between" marginBottom="spacing.2">
                      <Badge color={row.stage === "agent_decided" ? "information" : "positive"}>
                        {row.stage.replace("_", " ")}
                      </Badge>
                      <Text size="small" color="surface.text.gray.muted">
                        {new Date(row.created_at).toLocaleTimeString()}
                      </Text>
                    </Box>
                    {row.event && (
                      <Text size="small" color="surface.text.gray.muted">
                        {row.event.root_cause} · {rupees(row.event.amount_paise)}
                      </Text>
                    )}
                    <Text>{(row.detail as any)?.rationale ?? JSON.stringify(row.detail)}</Text>
                  </CardBody>
                </Card>
              ))}
          </Box>
        </Box>

        {/* --- Root Cause Breakdown + Exceptions --- */}
        <Box flex="1" minWidth="320px">
          <Heading size="small" marginBottom="spacing.3">
            Breakdown by root cause
          </Heading>
          <Box display="flex" flexDirection="column" gap="spacing.2" marginBottom="spacing.6">
            {summary &&
              Object.entries(summary.by_root_cause).map(([cause, stats]) => (
                <Box key={cause} display="flex" justifyContent="space-between">
                  <Text>{cause}</Text>
                  <Text color="surface.text.gray.muted">
                    {stats.count} · {rupees(stats.amount_paise)}
                  </Text>
                </Box>
              ))}
          </Box>

          <Divider marginBottom="spacing.4" />

          <Heading size="small" marginBottom="spacing.3">
            Exceptions — could not resolve
          </Heading>
          <Box display="flex" flexDirection="column" gap="spacing.2">
            {summary?.exceptions.length ? (
              summary.exceptions.map((exc, i) => (
                <Box key={i} display="flex" justifyContent="space-between">
                  <Text size="small">{exc.revenue_event_id.slice(0, 8)}…</Text>
                  <Badge color="negative">{exc.reason}</Badge>
                </Box>
              ))
            ) : (
              <Text color="surface.text.gray.muted">No unresolved exceptions yet.</Text>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive";
}) {
  return (
    <Card>
      <CardBody>
        <Text size="small" color="surface.text.gray.muted">
          {label}
        </Text>
        <Heading size="medium" color={tone === "positive" ? "feedback.text.positive.intense" : undefined}>
          {value}
        </Heading>
      </CardBody>
    </Card>
  );
}
