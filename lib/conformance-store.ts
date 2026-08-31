import { supabase } from "./supabase";
import { DEFAULT_POLICY } from "./policy";
import { verifyConformance, type ConformanceInput, type ConformanceReport } from "./invariants";
import { estimateComplianceCost, type BlockedEvent, type ComplianceCostReport } from "./compliance-cost";
import { estimateRecoveryProbability } from "./propensity";
import { tallyByRootCause } from "./propensity";

/**
 * Loads everything the conformance verifier and the compliance-cost estimate
 * need, then runs both.
 *
 * Pagination matters here rather than being defensive habit: PostgREST caps a
 * plain select at 1000 rows, and an 800-event batch writes several thousand
 * audit entries. A silently truncated read would make the verifier check a
 * fraction of the batch and report a clean pass — the worst possible failure
 * mode for something whose entire job is to be trustworthy.
 */

const PAGE_SIZE = 1000;

async function fetchAll<T>(
  build: () => any,
  label: string
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);

    if (error) return { rows, error: `${label}: ${error.message}` };
    if (!data || data.length === 0) break;

    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
  }

  return { rows, error: null };
}

export interface ConformanceBundle {
  conformance: ConformanceReport;
  complianceCost: ComplianceCostReport;
}

export async function runConformance(
  db: Pick<typeof supabase, "from"> = supabase
): Promise<ConformanceBundle> {
  const [events, decisions, actions, consent, assignments, stops, outcomes] =
    await Promise.all([
      fetchAll<any>(
        () => db.from("revenue_events").select("id, customer_id, amount_paise, root_cause"),
        "revenue_events"
      ),
      fetchAll<any>(
        () => db.from("agent_decisions").select("id, revenue_event_id, chosen_action, rationale, root_cause"),
        "agent_decisions"
      ),
      fetchAll<any>(
        () =>
          db
            .from("recovery_actions")
            .select("agent_decision_id, channel, status, attempt_number, executed_at"),
        "recovery_actions"
      ),
      fetchAll<any>(() => db.from("customer_consent").select("customer_id, dnd"), "customer_consent"),
      fetchAll<any>(
        () => db.from("experiment_assignments").select("revenue_event_id, arm"),
        "experiment_assignments"
      ),
      fetchAll<any>(
        () =>
          db
            .from("audit_log")
            .select("revenue_event_id, detail")
            .eq("stage", "stopping_rule_triggered"),
        "audit_log"
      ),
      fetchAll<any>(
        () => db.from("outcomes").select("revenue_event_id, recovered"),
        "outcomes"
      ),
    ]);

  const failure = [events, decisions, actions, consent, assignments, stops, outcomes].find(
    (r) => r.error
  );
  if (failure?.error) {
    throw new Error(`Conformance load failed — ${failure.error}`);
  }

  const input: ConformanceInput = {
    events: events.rows,
    decisions: decisions.rows,
    actions: actions.rows,
    consent: consent.rows,
    assignments: assignments.rows,
    policy: DEFAULT_POLICY,
  };

  // Propensity for the cost estimate, learned from the batch's own outcomes.
  const rootCauseByEvent = new Map<string, string | null>(
    events.rows.map((e: any) => [e.id, e.root_cause])
  );
  const decidedEventIds = new Set(decisions.rows.map((d: any) => d.revenue_event_id));
  const recoveredEventIds = new Set(
    outcomes.rows.filter((o: any) => o.recovered).map((o: any) => o.revenue_event_id)
  );

  const tally = tallyByRootCause(
    [...decidedEventIds].map((id) => ({
      root_cause: rootCauseByEvent.get(id) ?? null,
      recovered: recoveredEventIds.has(id),
    }))
  );

  const blocked: BlockedEvent[] = stops.rows
    .map((row: any) => {
      const event = events.rows.find((e: any) => e.id === row.revenue_event_id);
      if (!event) return null;
      return {
        revenue_event_id: row.revenue_event_id,
        reason: row.detail?.reason ?? "unknown",
        amount_paise: event.amount_paise,
        root_cause: event.root_cause,
      };
    })
    .filter(Boolean) as BlockedEvent[];

  const complianceCost = estimateComplianceCost(
    blocked,
    (rootCause) => estimateRecoveryProbability(rootCause, tally[rootCause]),
    DEFAULT_POLICY
  );

  return { conformance: verifyConformance(input), complianceCost };
}
