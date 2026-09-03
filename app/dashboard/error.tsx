"use client";

import { useEffect } from "react";

/**
 * The demo's last line of defence.
 *
 * Without a boundary, one panel throwing takes the whole route with it and
 * React renders nothing at all — a white screen, mid-demo, with no way back
 * except a reload nobody watching will wait for. The panels here read from
 * five endpoints and render data shapes that change as the batch runs, so a
 * single unexpected null is a plausible way to lose the screen.
 *
 * It deliberately does NOT swallow the error. The message is shown, because
 * a dashboard whose entire thesis is an honest audit trail cannot respond to
 * its own failure by pretending nothing happened — and because the fastest
 * fix during a demo is knowing which panel broke.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] render failed:", error);
  }, [error]);

  return (
    <div className="rr-page">
      <div className="rr-shell" style={{ paddingTop: 48, maxWidth: 640 }}>
        <div className="rr-card">
          <div className="rr-caps rr-mono" style={{ marginBottom: 12 }}>
            The dashboard could not render
          </div>

          <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--rr-text-2)", marginTop: 0 }}>
            The pipeline and the database are unaffected — this is the view
            failing, not the agent. Recovery events already recorded are safe,
            and the webhook continues to accept deliveries.
          </p>

          <pre className="rr-pre rr-mono" style={{ marginTop: 14 }}>
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="rr-btn" style={{ width: "auto" }} onClick={reset}>
              Try again
            </button>
            <a
              className="rr-btn"
              style={{ width: "auto", textAlign: "center", textDecoration: "none" }}
              href="/api/health"
            >
              Check service health
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
