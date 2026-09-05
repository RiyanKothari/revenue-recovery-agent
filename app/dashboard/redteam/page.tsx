"use client";

import { useEffect, useState } from "react";
import { Chip, Header, SectionTitle } from "../ui";

/**
 * The Red Team screen.
 *
 * Every defence in this system is invisible when it works, which makes the
 * most differentiated work in the project impossible to see in a demo. This
 * screen attacks the system with real hostile inputs and shows it refusing,
 * one at a time.
 *
 * It reports failures as failures. A panel that could only ever show green
 * would be decoration, and the whole argument of this project is that a claim
 * you cannot see fail is not evidence.
 */

interface AttackResult {
  id: string;
  attack: string;
  defence: string;
  outcome: string;
  blocked: boolean;
  source: string;
}

interface RedTeamResponse {
  results: AttackResult[];
  total: number;
  held: number;
  breached: number;
}

export default function RedTeamPage() {
  const [data, setData] = useState<RedTeamResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [revealed, setRevealed] = useState(0);

  const run = async () => {
    setRunning(true);
    setError(null);
    setRevealed(0);
    try {
      const res = await fetch("/api/redteam");
      if (!res.ok) throw new Error("The red team suite could not run.");
      const body: RedTeamResponse = await res.json();
      setData(body);

      /**
       * Revealed one at a time rather than all at once. This is the one place
       * in the project where pacing is the point: a wall of ten green rows
       * reads as a screenshot, whereas watching each attack land and be
       * refused reads as something happening. The results are already
       * computed — the animation reveals them, it does not fake them.
       */
      for (let i = 1; i <= body.results.length; i++) {
        await new Promise((r) => setTimeout(r, 260));
        setRevealed(i);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to run");
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = data?.results.slice(0, revealed) ?? [];

  return (
    <div className="rr-page">
      <Header />

      <div className="rr-shell" style={{ paddingTop: 24, maxWidth: 1040 }}>
        <div className="rr-card" style={{ marginBottom: 16 }}>
          <SectionTitle
            right={
              data ? (
                <Chip tone={data.breached === 0 ? "green" : "red"}>
                  {data.breached === 0
                    ? `${data.held}/${data.total} held`
                    : `${data.breached} breached`}
                </Chip>
              ) : undefined
            }
          >
            Red team
          </SectionTitle>

          <p
            style={{
              fontSize: 13,
              lineHeight: 1.65,
              color: "var(--rr-text-2)",
              margin: "0 0 14px",
            }}
          >
            Every safety rule in this system is invisible when it works — a
            fail-closed guardrail looks exactly like no guardrail until
            something attacks it. So this attacks it. Each row below is a real
            hostile input run against the same functions the webhook runs, not
            a reimplementation of them.
          </p>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="rr-btn"
              style={{ width: "auto" }}
              onClick={run}
              disabled={running}
            >
              {running ? "Running…" : "▶ Run the attacks again"}
            </button>
            <span style={{ fontSize: 11, color: "var(--rr-text-3)" }}>
              Read-only — nothing here writes to the audit trail it is vouching for.
            </span>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "var(--rr-red)", marginTop: 12 }}>{error}</div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((r) => (
            <div
              key={r.id}
              className="rr-row"
              style={{
                ["--rail" as string]: r.blocked ? "var(--rr-green)" : "var(--rr-red)",
                cursor: "default",
              }}
            >
              <div className="rr-row__top">
                <span style={{ fontSize: 13, color: "var(--rr-text)" }}>{r.attack}</span>
                <Chip tone={r.blocked ? "green" : "red"}>
                  {r.blocked ? "refused" : "BREACHED"}
                </Chip>
              </div>

              <div style={{ fontSize: 12, color: "var(--rr-text-2)", marginBottom: 6 }}>
                {r.defence}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="rr-mono"
                  style={{
                    fontSize: 11.5,
                    color: r.blocked ? "var(--rr-green)" : "var(--rr-red)",
                  }}
                >
                  {r.outcome}
                </span>
                <span className="rr-mono" style={{ fontSize: 10.5, color: "var(--rr-text-3)" }}>
                  {r.source}
                </span>
              </div>
            </div>
          ))}

          {running && shown.length < (data?.results.length ?? 0) && (
            <div style={{ fontSize: 12, color: "var(--rr-text-3)", padding: "6px 2px" }}>
              attacking…
            </div>
          )}
        </div>

        {data && revealed === data.results.length && (
          <div className="rr-notice" style={{ marginTop: 18 }}>
            <span aria-hidden="true">■</span>
            <span>
              {data.breached === 0 ? (
                <>
                  All {data.total} attacks refused. Two of these were <strong>real
                  defects found during development</strong>, not hypotheticals: an
                  empty webhook secret made forged signatures verifiable, and a
                  malformed <code>WHATSAPP_DRY_RUN</code> value silently switched
                  the pipeline to live sends. Both now fail closed — and this page
                  is how you would know if either ever regressed.
                </>
              ) : (
                <>
                  <strong>{data.breached} defence(s) breached.</strong> This is a
                  real result, not a display bug — a rule that used to hold has
                  regressed and the row above names which one.
                </>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
