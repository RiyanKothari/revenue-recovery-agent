import { supabase } from "./supabase";
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
export async function getObservedStats(
  rootCause: string,
  db: Pick<typeof supabase, "from"> = supabase
): Promise<ObservedStats> {
  const [trialsRes, successesRes] = await Promise.all([
    db
      .from("agent_decisions")
      .select("id", { count: "exact", head: true })
      .eq("root_cause", rootCause),
    db
      .from("outcomes")
      .select("id, revenue_events!inner(root_cause)", {
        count: "exact",
        head: true,
      })
      .eq("revenue_events.root_cause", rootCause)
      .eq("recovered", true),
  ]);

  if (trialsRes.error || successesRes.error) {
    console.error(
      "[propensity] falling back to prior:",
      trialsRes.error?.message ?? successesRes.error?.message
    );
    return { trials: 0, successes: 0 };
  }

  return {
    trials: trialsRes.count ?? 0,
    successes: successesRes.count ?? 0,
  };
}
