import { getDb } from "./db";
import type { ObservedStats } from "./propensity";

/**
 * Reads the pipeline's own history to estimate how often a given root cause
 * actually converts.
 *
 * Note what counts as a trial. The `outcomes` table only ever gains a row
 * when money comes back, so counting rows there would make every probability
 * ~1. A trial is an event the agent actually acted on — an `agent_decisions`
 * row — and a success is one of those that later produced a recovered
 * outcome.
 *
 * Failures are advisory: a missing count degrades the estimate toward the
 * prior, which is the safe direction, so this never blocks the pipeline.
 */
export async function getObservedStats(rootCause: string): Promise<ObservedStats> {
  try {
    const db = getDb();
    const [trials, successes] = await Promise.all([
      db.countDecisionsByRootCause(rootCause),
      db.countRecoveredByRootCause(rootCause),
    ]);
    return { trials, successes };
  } catch (err: any) {
    console.error("[propensity] falling back to prior:", err?.message ?? err);
    return { trials: 0, successes: 0 };
  }
}
