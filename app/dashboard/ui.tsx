"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Text } from "@razorpay/blade/components";

/**
 * Shared chrome and formatting for the three Desk screens.
 *
 * Kept in one module because the header, the money units and the vocabulary
 * are the parts that must not drift between pages: a rupee rendered two ways,
 * or a stopping reason labelled differently on the ledger than on the trace,
 * would make the same event look like two events.
 */

export function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

export function rupeesExact(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Durations read as "18m 42s" up to an hour, then "9h 22m". */
export function duration(minutes: number): string {
  if (minutes < 60) {
    const m = Math.floor(minutes);
    const s = Math.round((minutes - m) * 60);
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(minutes / 60);
  return `${h}h ${Math.round(minutes - h * 60)}m`;
}

export function humanise(value: string): string {
  const cleaned = value.replace(/^guardrail_check_failed:/, "").replace(/[_:]+/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function label(map: Record<string, string>, key: string | undefined): string {
  if (!key) return "—";
  return map[key] ?? humanise(key);
}

export const ROOT_CAUSE_LABELS: Record<string, string> = {
  insufficient_funds: "Insufficient funds",
  bank_timeout: "Bank timeout",
  card_declined: "Card declined",
  gateway_error: "Gateway error",
  network_drop: "Network drop",
  invalid_credentials: "Invalid credentials",
  unknown: "Unknown",
  unclassified: "Unclassified",
};

export const ACTION_LABELS: Record<string, string> = {
  send_retry_link_whatsapp: "WhatsApp retry",
  send_retry_link_email: "Email retry",
  escalate_human: "Escalated to human",
};

export const EXECUTED_LABELS: Record<string, string> = {
  whatsapp: "Sent via WhatsApp",
  email: "Sent via email",
  human_escalation: "Queued for human review",
};

export const REASON_LABELS: Record<string, string> = {
  customer_dnd_opt_out: "Customer opted out (DND)",
  max_retry_attempts_reached: "Reached retry limit",
  cooldown_window_active: "Inside cooldown window",
  refund_or_dispute_flagged: "Refunded or disputed",
  refund_or_dispute: "Refunded or disputed",
  not_recoverable_or_unknown_cause: "Unrecognised failure — needs review",
  agent_returned_unusable_decision: "Agent response unusable — escalated",
  negative_expected_value: "Not worth chasing",
  no_customer_identifier: "No customer id — consent unverifiable",
  holdout_control: "Holdout control — deliberately untreated",
  experiment_assignment_failed: "Could not record experiment arm",
  stored_payload_unreadable: "Stored payload unreadable",
  pipeline_error: "Pipeline error",
};

export function reasonLabel(reason: string | undefined): string {
  if (!reason) return "—";
  if (reason.startsWith("guardrail_check_failed")) {
    return "Safety check unavailable — held back";
  }
  return label(REASON_LABELS, reason);
}

/**
 * Not every stopped event is a failure. A holdout control was withheld to
 * measure the baseline, and a negative-EV skip is the agent correctly
 * declining to spend ₹50 chasing ₹40. Filing either under "could not
 * resolve" would misrepresent deliberate judgment as a shortcoming.
 */
export const DELIBERATE_REASONS = new Set(["holdout_control", "negative_expected_value"]);

// --- chrome ----------------------------------------------------------------

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/policy", label: "Policy Lab" },
];

export type FeedStatus = "connecting" | "live" | "offline";

export function Header({ status }: { status?: FeedStatus }) {
  const pathname = usePathname();

  return (
    <header className="rr-header">
      <span className="rr-brand">Revenue Recovery — Live</span>
      <span className="rr-pill rr-pill--test rr-mono">Test mode</span>

      <nav className="rr-nav">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            data-active={
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href)
            }
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {status && <StatusPill status={status} />}
    </header>
  );
}

/** Colour never carries the meaning alone — the label always says it too. */
export function StatusPill({ status }: { status: FeedStatus }) {
  const config = {
    live: { cls: "rr-pill--live", text: "Live" },
    connecting: { cls: "rr-pill--stale", text: "Connecting" },
    offline: { cls: "rr-pill--offline", text: "Feed unavailable" },
  }[status];

  return (
    <span className={`rr-pill ${config.cls}`}>
      <span className="rr-dot" aria-hidden="true" />
      {config.text}
    </span>
  );
}

/**
 * Status chips are Blade Badges.
 *
 * The layout and the three custom visuals are hand-built because Blade has no
 * Sankey, no pipeline spine and no policy slider — but a status chip is
 * exactly the primitive a design system exists to own, and reimplementing one
 * in CSS would mean this project claims to be built on Razorpay's design
 * system while quietly not using it.
 *
 * Blade's Badge takes text-only children, so anything richer stays on the CSS
 * chip. Tones map onto Blade's semantic colours rather than raw hues, which
 * is what keeps these consistent with the Badges elsewhere in the product.
 */
const BADGE_COLOR = {
  green: "positive",
  blue: "information",
  amber: "notice",
  red: "negative",
  neutral: "neutral",
} as const;

export function Chip({
  tone,
  children,
}: {
  tone: "green" | "blue" | "amber" | "red" | "neutral";
  children: React.ReactNode;
}) {
  if (typeof children === "string" || typeof children === "number") {
    return <Badge color={BADGE_COLOR[tone]}>{String(children)}</Badge>;
  }
  return <span className={`rr-chip rr-chip--${tone}`}>{children}</span>;
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rr-card__head">
      {/* Blade's Text carries the type ramp; the wrapper adds only the ledger
          register and the caps treatment, which are not Blade's to own. */}
      <span className="rr-caps rr-mono">
        <Text size="small" weight="semibold" color="surface.text.gray.muted">
          {typeof children === "string" ? children.toUpperCase() : children}
        </Text>
      </span>
      {right}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Numbers tween to their value on arrival and on genuine change — never on
 * every poll. Figures that re-animate each tick read as unstable, which is
 * the opposite of what a ledger should feel like.
 */
export function useCountUp(target: number | null, durationMs = 650): number {
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
      if (t < 1) frame = requestAnimationFrame(tick);
      else fromRef.current = target;
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return display;
}

export function Stat({
  label: statLabel,
  value,
  format,
  rail,
  sub,
}: {
  label: string;
  value: number | null;
  format: (n: number) => string;
  rail: string;
  sub?: string;
}) {
  const animated = useCountUp(value);

  return (
    <div className="rr-stat" style={{ ["--rail" as string]: rail }}>
      <div className="rr-stat__label">{statLabel}</div>
      {/* Null renders as an em dash, never as zero: "we don't know yet" and
          "nothing was recovered" are the two readings this page must never
          let a reader confuse. */}
      <div className="rr-stat__value rr-mono">{value == null ? "—" : format(animated)}</div>
      {sub && <div className="rr-stat__sub">{sub}</div>}
    </div>
  );
}
