import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { buildTrace } from "@/lib/trace";

export const dynamic = "force-dynamic";

/**
 * One event's full path through the pipeline, reconstructed from the audit
 * trail alone.
 *
 * This is the endpoint behind "click any row and see exactly what happened".
 * Everything it returns is derived from recorded rows — the stage spine comes
 * from `audit_log`, the decision from `agent_decisions`, the result from
 * `outcomes` — so it can only ever show what the pipeline actually wrote
 * down. That constraint is the point: a trace assembled by threading a status
 * object through the pipeline would show what the code intended, which is
 * precisely the thing under question.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const eventId = params.id;

  try {
    const db = getDb();

    const [auditRows, events, decisions, outcomes] = await Promise.all([
      db.listAuditForEvent(eventId),
      db.listEventsByIds([eventId]),
      db.listDecisions(),
      db.listOutcomes(),
    ]);

    const event = events[0] ?? null;

    /**
     * An unknown id is a 404, not an empty trace. An empty spine rendered for
     * a typo'd id would look like an event the pipeline silently ignored —
     * the most alarming thing this screen could imply, and untrue.
     */
    if (!event && auditRows.length === 0) {
      return NextResponse.json({ error: "event_not_found", id: eventId }, { status: 404 });
    }

    const trace = buildTrace(auditRows);
    const decision = decisions.find((d) => d.revenue_event_id === eventId) ?? null;
    const outcome = outcomes.find((o) => o.revenue_event_id === eventId) ?? null;

    return NextResponse.json({
      event_id: eventId,
      event,
      trace,
      decision,
      outcome,
      // The raw rows, so the UI can show the untouched record underneath the
      // rendered spine. If the two ever disagree, the reader should be able
      // to see it rather than take the summary's word for it.
      audit: auditRows,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "trace_query_failed", detail: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
