import { getDb, type RecoveryDb } from "./db";
import { DEFAULT_POLICY } from "./policy";
import { verifyConformance, type ConformanceInput, type ConformanceReport } from "./invariants";
import {
  estimateComplianceCost,
  type BlockedEvent,
  type ComplianceCostReport,
} from "./compliance-cost";
import { estimateRecoveryProbability, tallyByRootCause } from "./propensity";

/**
 * Loads everything the conformance verifier and the compliance-cost estimate
 * need, then runs both.
 *
 * Reads go through the repository rather than a hosted query API, so there is
 * no hidden row cap to trip over. That mattered: PostgREST silently truncates
 * a plain select at 1000 rows, and an 800-event batch writes several thousand
 * audit entries — the verifier would have checked a slice of the batch and
 * reported a clean pass, which is the worst possible failure mode for
 * something whose entire job is to be trustworthy.
 */

export interface ConformanceBundle {
  conformance: ConformanceReport;
  complianceCost: ComplianceCostReport;
}

export async function runConformance(
  db: RecoveryDb = getDb()
): Promise<ConformanceBundle> {
  const [events, decisions, actions, consent, assignments, stops, outcomes] =
    await Promise.all([
      db.listEvents(),
      db.listDecisions(),
      db.listRecoveryActions(),
      db.listConsent(),
      db.listAssignments(),
      db.listStoppingRules(),
      db.listOutcomes(),
    ]);

  const input: ConformanceInput = {
    events,
    decisions,
    actions,
    consent,
    assignments,
    policy: DEFAULT_POLICY,
  };

  // Propensity for the cost estimate, learned from the batch's own outcomes.
  const rootCauseByEvent = new Map(events.map((e) => [e.id, e.root_cause]));
  const decidedEventIds = new Set(decisions.map((d) => d.revenue_event_id));
  const recoveredEventIds = new Set(
    outcomes.filter((o) => o.recovered).map((o) => o.revenue_event_id)
  );

  const tally = tallyByRootCause(
    [...decidedEventIds].map((id) => ({
      root_cause: rootCauseByEvent.get(id) ?? null,
      recovered: recoveredEventIds.has(id),
    }))
  );

  // Indexed rather than scanned: an 800-event batch produces thousands of
  // stop entries, and a nested find() here made the conformance endpoint do
  // over a million comparisons on every dashboard poll.
  const eventById = new Map(events.map((e) => [e.id, e]));

  const blocked: BlockedEvent[] = [];
  for (const stop of stops) {
    const event = eventById.get(stop.revenue_event_id);
    if (!event) continue;
    blocked.push({
      revenue_event_id: stop.revenue_event_id,
      reason: stop.reason,
      amount_paise: event.amount_paise,
      root_cause: event.root_cause,
    });
  }

  const complianceCost = estimateComplianceCost(
    blocked,
    (rootCause) => estimateRecoveryProbability(rootCause, tally[rootCause]),
    DEFAULT_POLICY
  );

  return { conformance: verifyConformance(input), complianceCost };
}
