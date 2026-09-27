"use client";

import { useState } from "react";
import { rupeesExact } from "../dashboard/ui";

/**
 * The page a customer lands on when they do not trust a message.
 *
 * Deliberately the plainest screen in this project. It is reached by someone
 * who is already suspicious, on a phone, possibly while being socially
 * engineered, and every element of visual polish is something a phishing site
 * can copy more cheaply than this can defend. So there is no logo to imitate,
 * no reassuring green badge before the check has happened, and no branding
 * that would make a clone convincing. The only thing here worth copying is
 * the answer, and a clone cannot produce it.
 *
 * The interaction is a challenge, not a lookup. The customer tells the page
 * what they tried to pay; the page confirms or denies. It never volunteers
 * the amount, because a page that shows payment details in exchange for a
 * code is an oracle — a scammer who harvests codes learns who has failed
 * payments, for how much, and when, which is precisely the material that
 * makes the next message convincing.
 */

type Outcome =
  | { status: "verified"; merchantName: string; amountPaise: number; failedAtIso: string }
  | { status: "mismatch"; attemptsRemaining: number }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "locked" }
  | { status: "malformed" }
  | { status: "unavailable" }
  | { status: "rate_limited" };

const TONE: Record<Outcome["status"], string> = {
  verified: "var(--rr-green)",
  mismatch: "var(--rr-red)",
  unknown: "var(--rr-red)",
  expired: "var(--rr-amber)",
  locked: "var(--rr-amber)",
  malformed: "var(--rr-neutral)",
  unavailable: "var(--rr-amber)",
  rate_limited: "var(--rr-amber)",
};

/**
 * The copy is the security control on this page.
 *
 * Two rules it follows. A refusal never says "this is a scam", because the
 * honest limit of what this knows is that no payment matches — the customer
 * may simply have typed the wrong figure, and telling them to call their bank
 * about a genuine purchase is its own harm. And `unavailable` never resembles
 * a refusal, because "we could not check" and "there is no such payment" are
 * completely different statements and showing them alike is how a page lies.
 */
function message(outcome: Outcome): { title: string; body: string } {
  switch (outcome.status) {
    case "verified":
      return {
        title: "This matches a real failed payment",
        body: `${outcome.merchantName} recorded a failed payment of ${rupeesExact(
          outcome.amountPaise
        )} on ${new Date(outcome.failedAtIso).toLocaleString("en-IN", {
          dateStyle: "medium",
          timeStyle: "short",
        })}. The message you received was sent for that payment.`,
      };
    case "mismatch":
      return {
        title: "That amount does not match",
        body:
          outcome.attemptsRemaining > 0
            ? `No failed payment for that amount is linked to this code. Check the figure in your bank or UPI app and try again. ${outcome.attemptsRemaining} ${
                outcome.attemptsRemaining === 1 ? "try" : "tries"
              } left.`
            : "No failed payment for that amount is linked to this code, and this code has no tries left. Contact the merchant directly, using a number you already had.",
      };
    case "unknown":
      return {
        title: "No such code",
        body: "Nothing in this system was ever sent with that code. Do not use any link in that message, and do not enter card or UPI details from it.",
      };
    case "expired":
      return {
        title: "This code has expired",
        body: "Codes stop answering after three days. If the message is recent, check the code again. If it is older than that, contact the merchant directly rather than using the link.",
      };
    case "locked":
      return {
        title: "Too many tries on this code",
        body: "This code has stopped answering. That limit exists so nobody can guess their way to an answer. Contact the merchant directly, using a number you already had.",
      };
    case "malformed":
      return {
        title: "Enter the amount as a number",
        body: "For example 2499, or 2499.50. This did not count as a try.",
      };
    case "rate_limited":
      return {
        title: "Too many checks from here",
        body: "Wait a minute and try again.",
      };
    case "unavailable":
      return {
        title: "Could not check right now",
        body: "This is not an answer about your message, it means the check itself did not run. Try again shortly, and until then treat the message as unverified.",
      };
  }
}

export default function VerifyPage() {
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);

    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, amount }),
      });

      if (res.status === 429) setOutcome({ status: "rate_limited" });
      else setOutcome(await res.json());
    } catch {
      // A network failure is not a verdict about the message. Same reasoning
      // as the server's fail-closed path: never let "could not check" render
      // as "checked, and it is fine".
      setOutcome({ status: "unavailable" });
    } finally {
      setBusy(false);
    }
  }

  const tone = outcome ? TONE[outcome.status] : undefined;
  const said = outcome ? message(outcome) : null;

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.heading}>Check a payment message</h1>
        <p style={styles.lede}>
          Got a message saying a payment failed? Do not trust it because it looks right.
          Enter the code from the message and the amount you tried to pay.
        </p>

        <form onSubmit={check}>
          <label style={styles.label} htmlFor="code">
            Code from the message
          </label>
          <input
            id="code"
            style={{ ...styles.input, ...styles.mono }}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-1234"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
          />

          <label style={styles.label} htmlFor="amount">
            Amount you tried to pay
          </label>
          <input
            id="amount"
            style={{ ...styles.input, ...styles.mono }}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="2499"
            // `inputMode` rather than `type="number"`: a number input on
            // mobile silently drops what it cannot parse, and this field must
            // see exactly what the customer typed so a bad figure can be
            // answered rather than swallowed.
            inputMode="decimal"
            autoComplete="off"
            required
          />

          <button style={{ ...styles.button, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? "Checking" : "Check this message"}
          </button>
        </form>

        {said && (
          // aria-live, because the answer replaces nothing on screen and a
          // screen reader would otherwise never announce the one thing the
          // customer came for.
          <div role="status" aria-live="polite" style={{ ...styles.result, borderColor: tone }}>
            <strong style={{ color: tone, display: "block", marginBottom: 6 }}>
              {said.title}
            </strong>
            <span style={{ color: "var(--rr-text-2)" }}>{said.body}</span>
          </div>
        )}

        <p style={styles.footer}>
          This page never tells you the amount. It only confirms what you already
          know, so that someone who does not know it cannot find it out here.
        </p>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--rr-bg)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    background: "var(--rr-surface)",
    border: "1px solid var(--rr-border)",
    borderRadius: 14,
    padding: 24,
  },
  heading: { color: "var(--rr-text)", fontSize: 21, margin: "0 0 8px", fontWeight: 600 },
  lede: { color: "var(--rr-text-2)", fontSize: 14, lineHeight: 1.55, margin: "0 0 22px" },
  label: {
    display: "block",
    color: "var(--rr-text-2)",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: "var(--rr-sunken)",
    border: "1px solid var(--rr-border-strong)",
    borderRadius: 8,
    color: "var(--rr-text)",
    padding: "11px 13px",
    fontSize: 16, // 16px or iOS zooms the page on focus
    marginBottom: 18,
  },
  mono: { fontFamily: "var(--font-mono), monospace", letterSpacing: "0.04em" },
  button: {
    width: "100%",
    background: "var(--rr-blue)",
    border: "none",
    borderRadius: 8,
    color: "#06121f",
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  result: {
    marginTop: 20,
    padding: 15,
    borderRadius: 10,
    border: "1px solid",
    background: "var(--rr-surface-2)",
    fontSize: 14,
    lineHeight: 1.55,
  },
  footer: {
    marginTop: 22,
    paddingTop: 16,
    borderTop: "1px solid var(--rr-border)",
    color: "var(--rr-text-3)",
    fontSize: 12,
    lineHeight: 1.55,
    margin: "22px 0 0",
  },
};
