/**
 * Where the money went, in rupees rather than event counts.
 *
 * The dashboard already lists which events stopped and why, but a list of
 * reasons is not the shape the question is asked in. The question a payments
 * team asks is "of everything at risk, how much came back, how much did we
 * deliberately not chase, and how much is still open" — and that is a
 * partition of an amount, not a tally of rows.
 *
 * Counting events instead of rupees would be actively misleading here. A
 * batch can stop 35 small events on cooldown and recover three large ones,
 * and an event-count view would report that as mostly-blocked when the money
 * says otherwise.
 *
 * Kept pure and separate from the route so the partition can be tested
 * directly: the property that matters is that the buckets sum to the total
 * with nothing double-counted and nothing dropped, and that is much easier to
 * assert on a function than on a JSON response.
 */

export type BucketId =
  | "recovered"
  | "still_open"
  | "held_back"
  | "not_worth_chasing"
  | "holdout";

export interface Bucket {
  id: BucketId;
  label: string;
  events: number;
  amountPaise: number;
}

/**
 * Reasons that mean a guardrail or a degraded safety check stopped the event.
 * Anything namespaced `guardrail_check_failed:` also lands here — that is the
 * fail-closed path, where a check could not be evaluated and the event was
 * held back rather than risked.
 */
const HELD_BACK_REASONS = new Set([
  "customer_dnd_opt_out",
  "max_retry_attempts_reached",
  "cooldown_window_active",
  "refund_or_dispute_flagged",
  "no_customer_identifier",
  "not_recoverable_or_unknown_cause",
  "agent_returned_unusable_decision",
  "experiment_assignment_failed",
]);

export function bucketForReason(reason: string): BucketId {
  if (reason === "holdout_control") return "holdout";
  if (reason === "negative_expected_value") return "not_worth_chasing";
  if (reason.startsWith("guardrail_check_failed")) return "held_back";
  if (HELD_BACK_REASONS.has(reason)) return "held_back";

  /**
   * An unrecognised reason is held back, not silently dropped.
   *
   * Every stopping reason in this system means the event was not acted on, so
   * a reason added later that this file has not been taught about still
   * belongs in a bucket that says "we did not chase this". Defaulting to
   * "still open" would quietly move it into the pool the agent is presumed to
   * be working on, and the hero would overstate how much is in flight.
   */
  return "held_back";
}

const LABELS: Record<BucketId, string> = {
  recovered: "Recovered",
  still_open: "Still open",
  held_back: "Held back",
  not_worth_chasing: "Not worth chasing",
  holdout: "Holdout — measuring",
};

export interface BucketInput {
  /** Every event in the batch, with its amount. */
  events: { id: string; amount_paise: number }[];
  /** Events with a recovery, and what came back. */
  recovered: { revenue_event_id: string; recovered_amount_paise: number | null }[];
  /** Stopping rules recorded against events, newest first or any order. */
  stops: { revenue_event_id: string; reason: string }[];
}

export interface BucketResult {
  totalAtRiskPaise: number;
  buckets: Bucket[];
}

/**
 * Partitions the batch's at-risk amount into the five outcome buckets.
 *
 * Each event lands in exactly one bucket, resolved in this order:
 *
 *   1. Recovered wins over everything. A holdout control that converted on
 *      its own is still money that came back, and filing it under "holdout"
 *      would hide real recovery inside the measurement arm.
 *   2. Otherwise its stopping reason decides, if it has one. An event with
 *      several stopping rows takes the first — they are recorded as the
 *      pipeline halts, so the earliest is the one that actually stopped it.
 *   3. Otherwise it is still open: acted on, not yet resolved.
 *
 * The recovered bucket carries the amount that came back, which can differ
 * from the amount at risk (a partial recovery). Every other bucket carries
 * the amount at risk, since nothing came back from it. That means the buckets
 * do NOT sum to the total whenever a recovery was partial — which is correct,
 * and the caller should render the difference rather than force it to close.
 */
export function bucketOutcomes(input: BucketInput): BucketResult {
  const recoveredById = new Map(
    input.recovered.map((o) => [o.revenue_event_id, o.recovered_amount_paise ?? 0])
  );

  // First stop wins — later rows are consequences of the first, not new causes.
  const stopById = new Map<string, string>();
  for (const stop of input.stops) {
    if (!stopById.has(stop.revenue_event_id)) {
      stopById.set(stop.revenue_event_id, stop.reason);
    }
  }

  const tally: Record<BucketId, Bucket> = {
    recovered: { id: "recovered", label: LABELS.recovered, events: 0, amountPaise: 0 },
    still_open: { id: "still_open", label: LABELS.still_open, events: 0, amountPaise: 0 },
    held_back: { id: "held_back", label: LABELS.held_back, events: 0, amountPaise: 0 },
    not_worth_chasing: {
      id: "not_worth_chasing",
      label: LABELS.not_worth_chasing,
      events: 0,
      amountPaise: 0,
    },
    holdout: { id: "holdout", label: LABELS.holdout, events: 0, amountPaise: 0 },
  };

  let totalAtRiskPaise = 0;

  for (const event of input.events) {
    totalAtRiskPaise += event.amount_paise;

    const recovered = recoveredById.get(event.id);
    if (recovered !== undefined) {
      tally.recovered.events += 1;
      tally.recovered.amountPaise += recovered;
      continue;
    }

    const reason = stopById.get(event.id);
    const bucket = reason ? bucketForReason(reason) : "still_open";
    tally[bucket].events += 1;
    tally[bucket].amountPaise += event.amount_paise;
  }

  // Fixed order — the hero reads left to right as an outcome spectrum, best
  // to worst, and a bucket reordering itself as the batch runs would make the
  // one continuously-animated element on the page jump.
  const order: BucketId[] = [
    "recovered",
    "still_open",
    "held_back",
    "not_worth_chasing",
    "holdout",
  ];

  return { totalAtRiskPaise, buckets: order.map((id) => tally[id]) };
}
