"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * Shared furniture for the Attest console.
 *
 * Kept deliberately plain. The console's job is to let someone watch four
 * agents disagree with each other about the same input, and every pixel spent
 * on decoration is a pixel not spent making the disagreement legible.
 */

export type Tone = "good" | "bad" | "warn" | "neutral" | "info";

export const TONE_COLOR: Record<Tone, string> = {
  good: "var(--rr-green)",
  bad: "var(--rr-red)",
  warn: "var(--rr-amber)",
  neutral: "var(--rr-neutral)",
  info: "var(--rr-blue)",
};

export function Panel({
  title,
  kicker,
  children,
}: {
  title: string;
  kicker: string;
  children: ReactNode;
}) {
  return (
    <section style={styles.panel}>
      <header style={styles.panelHeader}>
        <h2 style={styles.panelTitle}>{title}</h2>
        <p style={styles.kicker}>{kicker}</p>
      </header>
      {children}
    </section>
  );
}

export function Tabs({
  options,
  active,
  onSelect,
}: {
  options: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={styles.tabs} role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={option.id === active}
          onClick={() => onSelect(option.id)}
          style={{
            ...styles.tab,
            ...(option.id === active ? styles.tabActive : null),
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Verdict({
  tone,
  label,
  detail,
}: {
  tone: Tone;
  label: string;
  detail: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ ...styles.verdict, borderColor: TONE_COLOR[tone] }}
    >
      <strong style={{ color: TONE_COLOR[tone], display: "block", marginBottom: 6 }}>
        {label}
      </strong>
      <span style={styles.verdictDetail}>{detail}</span>
    </div>
  );
}

/** A claim or finding line with its own verdict chip. */
export function Row({
  tone,
  chip,
  primary,
  secondary,
}: {
  tone: Tone;
  chip: string;
  primary: string;
  secondary: string;
}) {
  return (
    <li style={styles.row}>
      <span style={{ ...styles.chip, color: TONE_COLOR[tone], borderColor: TONE_COLOR[tone] }}>
        {chip}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={styles.rowPrimary}>{primary}</div>
        <div style={styles.rowSecondary}>{secondary}</div>
      </div>
    </li>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p style={styles.note}>{children}</p>;
}

export const styles: Record<string, CSSProperties> = {
  panel: {
    background: "var(--rr-surface)",
    border: "1px solid var(--rr-border)",
    borderRadius: 14,
    padding: 22,
    marginBottom: 20,
  },
  panelHeader: { marginBottom: 18 },
  panelTitle: {
    color: "var(--rr-text)",
    fontSize: 18,
    fontWeight: 600,
    margin: "0 0 5px",
  },
  kicker: {
    color: "var(--rr-text-2)",
    fontSize: 13.5,
    lineHeight: 1.55,
    margin: 0,
  },
  tabs: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  tab: {
    background: "var(--rr-sunken)",
    // Longhand, because `tabActive` overrides borderColor. Mixing the `border`
    // shorthand with a longhand override across a rerender makes React drop
    // the border entirely, and it warns about it for good reason.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--rr-border-strong)",
    borderRadius: 999,
    color: "var(--rr-text-2)",
    padding: "7px 14px",
    fontSize: 13,
    cursor: "pointer",
  },
  tabActive: {
    background: "var(--rr-blue-dim)",
    borderColor: "var(--rr-blue)",
    color: "var(--rr-text)",
  },
  verdict: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    background: "var(--rr-surface-2)",
    fontSize: 13.5,
    lineHeight: 1.55,
    marginBottom: 14,
  },
  verdictDetail: { color: "var(--rr-text-2)" },
  row: {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    padding: "11px 0",
    borderTop: "1px solid var(--rr-border)",
    listStyle: "none",
  },
  chip: {
    flexShrink: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontFamily: "var(--font-mono), monospace",
    marginTop: 2,
  },
  rowPrimary: { color: "var(--rr-text)", fontSize: 13.5, lineHeight: 1.5 },
  rowSecondary: {
    color: "var(--rr-text-3)",
    fontSize: 12.5,
    lineHeight: 1.5,
    marginTop: 3,
  },
  note: {
    color: "var(--rr-text-3)",
    fontSize: 12.5,
    lineHeight: 1.6,
    margin: "14px 0 0",
    paddingTop: 12,
    borderTop: "1px solid var(--rr-border)",
  },
  list: { margin: 0, padding: 0 },
  mono: { fontFamily: "var(--font-mono), monospace" },
  message: {
    background: "var(--rr-sunken)",
    border: "1px solid var(--rr-border-strong)",
    borderRadius: 10,
    padding: 14,
    color: "var(--rr-text)",
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    marginBottom: 14,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: "var(--rr-sunken)",
    border: "1px solid var(--rr-border-strong)",
    borderRadius: 8,
    color: "var(--rr-text)",
    padding: "10px 12px",
    fontSize: 16,
    fontFamily: "var(--font-mono), monospace",
    marginBottom: 12,
  },
  label: {
    display: "block",
    color: "var(--rr-text-2)",
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
  },
  button: {
    background: "var(--rr-blue)",
    border: "none",
    borderRadius: 8,
    color: "#06121f",
    padding: "11px 18px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  split: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 16,
  },
};
