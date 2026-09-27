"use client";

import { useMemo, useState } from "react";
import {
  CARTEL_SCENARIOS,
  FAIRNESS_SCENARIOS,
  NUDGE_FIXTURES,
  NUDGE_SCENARIOS,
  SENTINEL_CLAIMS,
  SENTINEL_CONFIGS,
  SENTINEL_MESSAGE,
  SENTINEL_NOW,
  createFixtureVerifierDb,
} from "@/lib/attest-scenarios";
import { verifyNudge } from "@/lib/nudge-verify-service";
import { screenMessage, type AdjudicatedClaim } from "@/lib/message-claims";
import { auditFairness, type FairnessFinding } from "@/lib/fairness-audit";
import { watchCategory } from "@/lib/cartel-watch";
import type { VerificationOutcome } from "@/lib/nudge-verification";
import { Note, Panel, Row, Tabs, Verdict, styles, type Tone } from "./ui";

/**
 * The Attest console.
 *
 * ## What it is
 *
 * Four agents, run live, in the browser. Every verdict on this page is
 * computed by the same function the production path calls — nothing here is a
 * recording, a screenshot or a hand-written outcome. What is fixture is only
 * the input: offer configurations, ledger rows, and the claims a model would
 * have extracted from a message.
 *
 * ## Why it needs no configuration at all
 *
 * All four agents are pure functions over data handed to them. None opens a
 * socket, reads a clock or calls a model. So this page runs with no database,
 * no API key and no network, which is worth more than elegance: a
 * demonstration that depends on a credential is a demonstration that breaks
 * an hour before someone looks at it, and the failure looks exactly like the
 * product not working.
 *
 * ## The one thing it does not pretend
 *
 * Claim extraction is the one step a model really does perform in production.
 * Here its output is shown as an input, and the page says so on screen. The
 * interesting half is what happens after extraction, and claiming a model ran
 * when none did would be precisely the sort of unevidenced assertion this
 * whole product argues against.
 */

export default function AttestConsole() {
  return (
    <main style={page}>
      <header style={header}>
        <h1 style={title}>Attest</h1>
        <p style={lede}>
          Payment agents act. This proves they behaved. Four agents running live below,
          with no database and no model behind them, because none of them needs one.
        </p>
      </header>

      <div style={column}>
        <NudgePanel />
        <SentinelPanel />
        <FairnessPanel />
        <CartelPanel />
      </div>

      <footer style={footer}>
        Every verdict on this page is computed by the same function the production path
        calls. The fixtures are the inputs, never the outcomes.
      </footer>
    </main>
  );
}

// --- Verified Nudge ---------------------------------------------------------

const NUDGE_TONE: Record<VerificationOutcome["status"], Tone> = {
  verified: "good",
  mismatch: "bad",
  unknown: "bad",
  expired: "warn",
  locked: "warn",
  malformed: "neutral",
  unavailable: "warn",
};

const NUDGE_LABEL: Record<VerificationOutcome["status"], string> = {
  verified: "This matches a real failed payment",
  mismatch: "That amount does not match",
  unknown: "No such code",
  expired: "This code has expired",
  locked: "Too many tries on this code",
  malformed: "Enter the amount as a number",
  unavailable: "Could not check right now",
};

function NudgePanel() {
  const [scenarioId, setScenarioId] = useState(NUDGE_SCENARIOS[0].id);
  const [amount, setAmount] = useState("2499");
  const [outcome, setOutcome] = useState<VerificationOutcome | null>(null);

  const scenario = NUDGE_SCENARIOS.find((s) => s.id === scenarioId)!;

  // One store for the life of the panel, so the attempt cap really does run
  // down as someone guesses. A store rebuilt on every check could not refuse,
  // and the cap is the only thing making the challenge more than a quiz.
  const db = useMemo(() => createFixtureVerifierDb(NUDGE_FIXTURES), []);

  async function check() {
    setOutcome(
      await verifyNudge({ code: scenario.code, amount }, { db, now: () => new Date() })
    );
  }

  return (
    <Panel
      title="Verified Nudge"
      kicker="A real payment link proves nothing, because anyone can generate one. So the customer is asked what they tried to pay, and the system only confirms or denies."
    >
      <Tabs
        options={NUDGE_SCENARIOS.map((s) => ({ id: s.id, label: s.label }))}
        active={scenarioId}
        onSelect={(id) => {
          setScenarioId(id);
          setOutcome(null);
        }}
      />

      <div style={styles.message}>{scenario.messageText}</div>

      <label style={styles.label} htmlFor="nudge-amount">
        Amount you tried to pay
      </label>
      <input
        id="nudge-amount"
        style={styles.input}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder="2499"
      />

      <button style={styles.button} onClick={check}>
        Check this message
      </button>

      {outcome && (
        <div style={{ marginTop: 16 }}>
          <Verdict
            tone={NUDGE_TONE[outcome.status]}
            label={NUDGE_LABEL[outcome.status]}
            detail={describeNudge(outcome)}
          />
        </div>
      )}

      <Note>{scenario.note}</Note>
    </Panel>
  );
}

function describeNudge(outcome: VerificationOutcome): string {
  switch (outcome.status) {
    case "verified":
      return `${outcome.merchantName} recorded a failed payment of ₹${(
        outcome.amountPaise / 100
      ).toLocaleString("en-IN")} on ${new Date(outcome.failedAtIso).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      })}. The message was sent for that payment.`;
    case "mismatch":
      return `No failed payment for that amount is linked to this code. ${outcome.attemptsRemaining} ${
        outcome.attemptsRemaining === 1 ? "try" : "tries"
      } left — the cap is what stops someone guessing their way to an answer.`;
    case "unknown":
      return "Nothing in this system was ever sent with that code. Do not use any link in that message.";
    case "locked":
      return "This code has stopped answering. Contact the merchant directly, using a number you already had.";
    case "expired":
      return "Codes stop answering after three days, so a harvested one is not a permanent oracle.";
    case "malformed":
      return "For example 2499, or 2499.50. This did not count as a try.";
    case "unavailable":
      return "Not an answer about your message: the check itself did not run. Treat the message as unverified.";
  }
}

// --- Dark Pattern Sentinel --------------------------------------------------

const CLAIM_TONE: Record<AdjudicatedClaim["verdict"], Tone> = {
  supported: "good",
  contradicted: "bad",
  unsupported: "warn",
};

function SentinelPanel() {
  const [configId, setConfigId] = useState(SENTINEL_CONFIGS[0].id);
  const config = SENTINEL_CONFIGS.find((c) => c.id === configId)!;

  const result = useMemo(
    () => screenMessage({ claims: SENTINEL_CLAIMS, facts: config.facts, nowIso: SENTINEL_NOW }),
    [config]
  );

  return (
    <Panel
      title="Dark Pattern Sentinel"
      kicker="Urgency is only a dark pattern when it is false. Switch the offer config below and watch the same sentence change verdict — the words never move."
    >
      <div style={styles.message}>{SENTINEL_MESSAGE}</div>

      <Tabs
        options={SENTINEL_CONFIGS.map((c) => ({ id: c.id, label: c.label }))}
        active={configId}
        onSelect={setConfigId}
      />

      <Verdict
        tone={result.decision === "send" ? "good" : "bad"}
        label={result.decision === "send" ? "Cleared to send" : "Held"}
        detail={result.summary}
      />

      <ul style={styles.list}>
        {result.claims.map((adjudicated, i) => (
          <Row
            key={i}
            tone={CLAIM_TONE[adjudicated.verdict]}
            chip={adjudicated.verdict}
            primary={`“${adjudicated.claim.text}”`}
            secondary={adjudicated.reason}
          />
        ))}
      </ul>

      <Note>
        {config.note} The claims above are what a model extracts; it is never asked
        whether anything is manipulative. That verdict is deterministic, which is why
        the same message can be honest under one configuration and not the other.
      </Note>
    </Panel>
  );
}

// --- Fairness Auditor -------------------------------------------------------

const FAIRNESS_TONE: Record<FairnessFinding["verdict"], Tone> = {
  disparity: "bad",
  no_disparity: "good",
  underpowered: "warn",
};

function FairnessPanel() {
  const [scenarioId, setScenarioId] = useState(FAIRNESS_SCENARIOS[0].id);
  const scenario = FAIRNESS_SCENARIOS.find((s) => s.id === scenarioId)!;

  const report = useMemo(
    () =>
      auditFairness({
        merchantId: "m_kettle",
        attribute: scenario.attribute,
        offers: scenario.offers,
      }),
    [scenario]
  );

  return (
    <Panel
      title="Fairness Auditor"
      kicker="Across customers, within one merchant. Every offer can sit inside the merchant's configured bands while the pattern discriminates, which is why per-offer checks report a clean record forever."
    >
      <Tabs
        options={FAIRNESS_SCENARIOS.map((s) => ({ id: s.id, label: s.label }))}
        active={scenarioId}
        onSelect={setScenarioId}
      />

      <Verdict
        tone={report.findings.some((f) => f.verdict === "disparity") ? "bad" : "info"}
        label={`Audited on “${report.attribute}”`}
        detail={report.summary}
      />

      <ul style={styles.list}>
        {report.findings.map((finding, i) => (
          <Row
            key={i}
            tone={FAIRNESS_TONE[finding.verdict]}
            chip={finding.verdict.replace("_", " ")}
            primary={`${finding.compared.group} (${finding.compared.favourable}/${finding.compared.n}) vs ${finding.reference.group} (${finding.reference.favourable}/${finding.reference.n})`}
            secondary={finding.reason}
          />
        ))}
      </ul>

      <Note>{scenario.note}</Note>
    </Panel>
  );
}

// --- Cartel Watch -----------------------------------------------------------

function CartelPanel() {
  const [scenarioId, setScenarioId] = useState(CARTEL_SCENARIOS[0].id);
  const scenario = CARTEL_SCENARIOS.find((s) => s.id === scenarioId)!;

  const report = useMemo(
    () =>
      watchCategory({
        category: scenario.category,
        offers: scenario.offers,
        cutoverIso: scenario.cutoverIso,
      }),
    [scenario]
  );

  const tone: Tone =
    report.severity === "proof" ? "bad" : report.severity === "signal" ? "warn" : "good";

  return (
    <Panel
      title="Cartel Watch"
      kicker="Across merchants, within one category. One agent deployed across competitors is structurally hub-and-spoke: the competitors never speak, and the shared algorithm speaks for them."
    >
      <Tabs
        options={CARTEL_SCENARIOS.map((s) => ({ id: s.id, label: s.label }))}
        active={scenarioId}
        onSelect={setScenarioId}
      />

      <Verdict
        tone={tone}
        label={
          report.severity === "proof"
            ? "Proof: competitor data reached a decision"
            : report.severity === "signal"
              ? "Signal: worth investigating"
              : "Nothing to report"
        }
        detail={report.summary}
      />

      <ul style={styles.list}>
        <Row
          tone={report.isolationViolations.length > 0 ? "bad" : "good"}
          chip="isolation"
          primary={
            report.isolationViolations.length > 0
              ? `${report.isolationViolations.length} decisions used a rival's data`
              : "No competitor data reached any decision"
          }
          secondary="A proof, not a statistic. It either happened or it did not, there is no threshold to argue about, and it is the mechanism the RealPage theory turned on."
        />
        <Row
          tone={
            report.convergence.verdict === "converging"
              ? "warn"
              : report.convergence.verdict === "no_control"
                ? "neutral"
                : "good"
          }
          chip={report.convergence.verdict.replace("_", " ")}
          primary={
            report.convergence.excessConvergence !== null
              ? `${report.convergence.excessConvergence.toFixed(2)}pp more convergence than merchants off the agent`
              : "Convergence not attributable"
          }
          secondary={report.convergence.reason}
        />
      </ul>

      <Note>{scenario.note}</Note>
    </Panel>
  );
}

// --- page chrome ------------------------------------------------------------

const page = {
  minHeight: "100vh",
  background: "var(--rr-bg)",
  padding: "40px 16px 60px",
} as const;

const header = { maxWidth: 780, margin: "0 auto 28px" } as const;

/** The panels share the header's measure, so the page reads as one column. */
const column = { maxWidth: 780, margin: "0 auto" } as const;

const title = {
  color: "var(--rr-text)",
  fontSize: 30,
  fontWeight: 600,
  margin: "0 0 10px",
  letterSpacing: "-0.01em",
} as const;

const lede = {
  color: "var(--rr-text-2)",
  fontSize: 15,
  lineHeight: 1.6,
  margin: 0,
  maxWidth: 620,
} as const;

const footer = {
  maxWidth: 780,
  margin: "0 auto",
  color: "var(--rr-text-3)",
  fontSize: 12.5,
  lineHeight: 1.6,
  paddingTop: 18,
  borderTop: "1px solid var(--rr-border)",
} as const;
