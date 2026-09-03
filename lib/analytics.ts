/**
 * The two questions the ledger cannot answer.
 *
 * The Desk shows what happened and what it cost. It has no time axis — so
 * "is this getting better or worse?" is unanswerable — and no view of which
 * failure types actually repay the effort, so "where should we spend?" is
 * unanswerable too. Both are the questions a payments lead asks second,
 * immediately after being convinced the thing works at all.
 *
 * Kept pure and separate from the route so the bucketing can be tested
 * directly. The properties that matter are that every event lands in exactly
 * one day and one cause, and that a cause with too few observations is
 * reported as such rather than shown as a rate — a single recovery out of one
 * attempt is not a 100% recovery rate, and a chart that says it is will be
 * believed.
 */

export interface AnalyticsEvent {
  id: string;
  amountPaise: number;
  rootCause: string | null;
  receivedAt: string;
}

export interface AnalyticsInput {
  events: AnalyticsEvent[];
  recoveredIds: Set<string>;
  /** Arm per event, for the treated-vs-control series. */
  armByEvent: Map<string, string>;
}

export interface DayPoint {
  /** ISO date, UTC. */
  day: string;
  failures: number;
  recovered: number;
  atRiskPaise: number;
  recoveredPaise: number;
}

export interface CausePerformance {
  cause: string;
  events: number;
  recovered: number;
  /** Null when there are too few observations to quote a rate. */
  recoveryRate: number | null;
  atRiskPaise: number;
  recoveredPaise: number;
  /** True when the sample is too small for the rate to mean anything. */
  sparse: boolean;
}

/**
 * Below this, a rate is noise wearing a percentage sign. One recovery from
 * one attempt is not a 100% recovery rate, and a bar chart that draws it at
 * full height will be read as one.
 */
export const MIN_EVENTS_FOR_RATE = 20;

function dayKey(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function dailySeries(input: AnalyticsInput): DayPoint[] {
  const byDay = new Map<string, DayPoint>();

  for (const event of input.events) {
    const day = dayKey(event.receivedAt);
    // An unparseable timestamp is dropped rather than bucketed to the epoch,
    // which would put a spike at 1970 and quietly distort the axis.
    if (!day) continue;

    const point =
      byDay.get(day) ??
      { day, failures: 0, recovered: 0, atRiskPaise: 0, recoveredPaise: 0 };

    point.failures += 1;
    point.atRiskPaise += event.amountPaise;

    if (input.recoveredIds.has(event.id)) {
      point.recovered += 1;
      point.recoveredPaise += event.amountPaise;
    }

    byDay.set(day, point);
  }

  // Chronological, because a time series that is not ordered by time is a bar
  // chart with a misleading x-axis.
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Which failure types repay the effort.
 *
 * Ordered by recovered rupees rather than by rate: a 40% recovery rate on
 * eleven small failures matters less than a 22% rate on four hundred large
 * ones, and sorting by rate would put the former at the top of a panel whose
 * whole purpose is directing where effort goes.
 */
export function causePerformance(input: AnalyticsInput): CausePerformance[] {
  const byCause = new Map<string, CausePerformance>();

  for (const event of input.events) {
    const cause = event.rootCause ?? "unclassified";

    const row =
      byCause.get(cause) ??
      {
        cause,
        events: 0,
        recovered: 0,
        recoveryRate: null,
        atRiskPaise: 0,
        recoveredPaise: 0,
        sparse: true,
      };

    row.events += 1;
    row.atRiskPaise += event.amountPaise;

    if (input.recoveredIds.has(event.id)) {
      row.recovered += 1;
      row.recoveredPaise += event.amountPaise;
    }

    byCause.set(cause, row);
  }

  return [...byCause.values()]
    .map((row) => ({
      ...row,
      sparse: row.events < MIN_EVENTS_FOR_RATE,
      recoveryRate: row.events < MIN_EVENTS_FOR_RATE ? null : row.recovered / row.events,
    }))
    .sort((a, b) => b.recoveredPaise - a.recoveredPaise);
}

export interface ArmSeriesPoint {
  day: string;
  treatedRate: number | null;
  controlRate: number | null;
  treatedN: number;
  controlN: number;
}

/**
 * Treated against control, day by day.
 *
 * Rates are null on days where an arm has too few observations rather than
 * plotted at zero — a control arm with two events on Tuesday says nothing
 * about Tuesday, and drawing it as 0% would invent a collapse that never
 * happened. The line simply breaks, which is what missing data should look
 * like.
 */
export function armSeries(input: AnalyticsInput): ArmSeriesPoint[] {
  const MIN_PER_DAY = 5;
  const byDay = new Map<
    string,
    { treatedN: number; treatedC: number; controlN: number; controlC: number }
  >();

  for (const event of input.events) {
    const arm = input.armByEvent.get(event.id);
    if (!arm) continue;

    const day = dayKey(event.receivedAt);
    if (!day) continue;

    const slot =
      byDay.get(day) ?? { treatedN: 0, treatedC: 0, controlN: 0, controlC: 0 };
    const recovered = input.recoveredIds.has(event.id);

    if (arm === "control") {
      slot.controlN += 1;
      if (recovered) slot.controlC += 1;
    } else {
      slot.treatedN += 1;
      if (recovered) slot.treatedC += 1;
    }

    byDay.set(day, slot);
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, s]) => ({
      day,
      treatedN: s.treatedN,
      controlN: s.controlN,
      treatedRate: s.treatedN >= MIN_PER_DAY ? s.treatedC / s.treatedN : null,
      controlRate: s.controlN >= MIN_PER_DAY ? s.controlC / s.controlN : null,
    }));
}
