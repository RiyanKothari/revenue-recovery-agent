/**
 * Price of Proof: what the holdout costs, and the moment it stopped being worth it.
 *
 * The lift on the dashboard is measured, not claimed, because a tenth of
 * eligible failures are deliberately left alone. That is the right design and
 * it has a price nobody prints: every customer in the control arm is a
 * customer the agent could have helped and did not. A merchant asked to
 * accept "we will withhold help from one in ten of your failed payments" is
 * entitled to ask for how long, and the industry answer is "indefinitely",
 * because stopping a test when the numbers look good is the textbook way to
 * fool yourself.
 *
 * That answer is a limitation of the statistics, not a law. A fixed-sample
 * interval — including the exact test this project uses for its headline
 * verdict — is valid only if you look once. Look after every event and stop
 * the first time it clears zero, and an experiment with no effect at all will
 * "prove" one far more often than 5% of the time. The simulation in the tests
 * measures how much more.
 *
 * A confidence sequence is valid at every moment simultaneously: the chance
 * that it EVER excludes the truth, across the whole run, is at most alpha.
 * That makes continuous monitoring legitimate, which turns a question nobody
 * could answer honestly — "have we learned enough yet?" — into one this module
 * answers after every event. Once the lower bound clears zero, every further
 * control customer is help withheld to buy certainty already owned, and this
 * module counts them and prices them.
 *
 * Method: the predictable plug-in empirical-Bernstein confidence sequence of
 * Waudby-Smith and Ramdas, "Estimating means of bounded random variables by
 * betting" (JRSS-B, 2024), applied to the inverse-propensity estimate of the
 * difference in recovery rates. Assignment is randomised with a known
 * probability (the policy's holdout percentage), so each event contributes an
 * unbiased, independent, BOUNDED term:
 *
 *   psi = Y·[treated]/(1 − pi) − Y·[control]/pi,   pi = P(control)
 *
 * whose mean is exactly treated rate minus control rate, and which always
 * lies in [−1/pi, 1/(1 − pi)].
 *
 * Empirical-Bernstein rather than the asymptotic sequence this was first
 * written with, and the reason is measured, not stylistic. Over 1,000
 * simulated runs with no effect at all, checked after every event, the
 * asymptotic sequence falsely proved one 6.0% of the time — over the 5% it
 * promises, because "asymptotic" means "eventually", and a demo batch is not
 * eventually. Empirical-Bernstein uses the bound on psi to make the guarantee
 * hold at every sample size: 1.2% on the same runs. It is wider, and proves a
 * 21pp lift around event 500 instead of 356. A tool whose whole claim is
 * "valid however often you look" does not get to be valid only usually.
 */

export interface ProofObservation {
  arm: "treated" | "control";
  recovered: boolean;
  /** The amount at risk on this event, in paise. */
  amountPaise: number;
  /** When the event arrived. Observations are read in this order. */
  atIso: string;
}

export interface ProofPoint {
  /** 1-based count of observations seen. */
  index: number;
  atIso: string;
  estimatePp: number;
  lowerPp: number;
  upperPp: number;
}

export type ProofVerdict = "proven" | "harm" | "not_yet" | "no_data";

export interface PriceOfProofReport {
  verdict: ProofVerdict;
  reason: string;
  alpha: number;
  controlProbability: number;
  observations: number;
  /** The interval now, valid no matter how often anyone looked before. */
  current: { estimatePp: number; lowerPp: number; upperPp: number } | null;
  /** When the lower bound first cleared zero (or the upper bound fell below it). */
  provenAt: { index: number; atIso: string; lowerPp: number; upperPp: number } | null;
  /** Control events assigned after the effect was already proven. */
  controlAfterProof: number;
  /** Every control event in the run — what the whole holdout withheld. */
  controlTotal: number;
  /**
   * Recovery those post-proof control customers are expected to have missed,
   * at the CURRENT lower bound of the lift: a figure the data supports at the
   * stated confidence, not the flattering point estimate.
   */
  forgoneAfterProofPaise: number;
  /** The same, at the point estimate, for scale. */
  forgoneAfterProofPointPaise: number;
  /** Downsampled for a chart; always includes the proof moment and the last point. */
  series: ProofPoint[];
}

/** Below this many per arm, nothing is declared, however the bound looks. */
export const MIN_PER_ARM_TO_DECLARE = 30;

const MAX_SERIES_POINTS = 120;

/** Largest bet allowed per observation; the paper's recommended 1/2. */
const MAX_LAMBDA = 0.5;

const toPp = (x: number) => x * 100;

export function measurePriceOfProof(
  input: ProofObservation[],
  options: { controlProbability: number; alpha?: number }
): PriceOfProofReport {
  const alpha = options.alpha ?? 0.05;
  const pi = options.controlProbability;

  const base = {
    alpha,
    controlProbability: pi,
    observations: input.length,
    controlTotal: input.filter((o) => o.arm === "control").length,
  };

  if (!(pi > 0 && pi < 1)) {
    throw new Error(`controlProbability must be strictly between 0 and 1, got ${pi}`);
  }

  if (input.length === 0) {
    return {
      ...base,
      verdict: "no_data",
      reason: "No assigned events yet.",
      current: null,
      provenAt: null,
      controlAfterProof: 0,
      forgoneAfterProofPaise: 0,
      forgoneAfterProofPointPaise: 0,
      series: [],
    };
  }

  // Arrival order, with the input order breaking ties so the result is
  // deterministic for a batch that shares timestamps.
  const ordered = input
    .map((o, i) => ({ o, i, t: Date.parse(o.atIso) }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.o);

  // psi rescaled to [0, 1], where the sequence is defined.
  const lo = -1 / pi;
  const hi = 1 / (1 - pi);
  const span = hi - lo;
  const logTwoOverAlpha = Math.log(2 / alpha);

  // Running state of the predictable plug-in empirical-Bernstein sequence.
  let sumLambda = 0;
  let sumLambdaX = 0;
  let sumPenalty = 0;
  let sumX = 0;
  let sumSq = 0;
  let muPrev = 0.5;
  let varPrev = 0.25;

  let treatedSeen = 0;
  let controlSeen = 0;
  let treatedRecovered = 0;
  let controlRecovered = 0;

  const all: ProofPoint[] = [];
  let provenAt: PriceOfProofReport["provenAt"] = null;
  let provenDirection: "benefit" | "harm" | null = null;

  ordered.forEach((o, k) => {
    const t = k + 1;
    const y = o.recovered ? 1 : 0;
    const psi = o.arm === "treated" ? y / (1 - pi) : -y / pi;
    const x = (psi - lo) / span;
    if (o.arm === "treated") {
      treatedSeen++;
      treatedRecovered += y;
    } else {
      controlSeen++;
      controlRecovered += y;
    }

    // The bet is chosen from what was known BEFORE this observation —
    // "predictable" is what makes the guarantee hold at every t at once.
    const lambda = Math.min(
      Math.sqrt((2 * logTwoOverAlpha) / (varPrev * t * Math.log(1 + t))),
      MAX_LAMBDA
    );
    sumLambda += lambda;
    sumLambdaX += lambda * x;
    sumPenalty += 4 * (x - muPrev) ** 2 * ((-Math.log(1 - lambda) - lambda) / 4);

    sumX += x;
    const mu = (0.5 + sumX) / (t + 1);
    sumSq += (x - mu) ** 2;
    muPrev = mu;
    varPrev = (0.25 + sumSq) / (t + 1);

    const center = sumLambdaX / sumLambda;
    const radius = (logTwoOverAlpha + sumPenalty) / sumLambda;

    // The point shown is the plain difference in rates — the same number the
    // headline lift reports — so the two panels never disagree about what
    // the effect is. The bounds come from the sequence.
    const estimate =
      treatedSeen > 0 && controlSeen > 0
        ? treatedRecovered / treatedSeen - controlRecovered / controlSeen
        : 0;
    const point: ProofPoint = {
      index: t,
      atIso: o.atIso,
      estimatePp: toPp(estimate),
      lowerPp: toPp(Math.max(-1, lo + span * (center - radius))),
      upperPp: toPp(Math.min(1, lo + span * (center + radius))),
    };
    all.push(point);

    const eligible =
      treatedSeen >= MIN_PER_ARM_TO_DECLARE && controlSeen >= MIN_PER_ARM_TO_DECLARE;
    if (!provenAt && eligible && (point.lowerPp > 0 || point.upperPp < 0)) {
      provenAt = { index: t, atIso: o.atIso, lowerPp: point.lowerPp, upperPp: point.upperPp };
      provenDirection = point.lowerPp > 0 ? "benefit" : "harm";
    }
  });

  const last = all[all.length - 1];
  const current = { estimatePp: last.estimatePp, lowerPp: last.lowerPp, upperPp: last.upperPp };

  // Help withheld after the answer was already known. Priced only for a
  // proven benefit: if treatment is proven harmful, the control arm is the
  // lucky one and nothing was forgone by being in it.
  const afterProof =
    provenAt && provenDirection === "benefit"
      ? ordered.slice((provenAt as { index: number }).index).filter((o) => o.arm === "control")
      : [];
  const atRisk = afterProof.reduce((s, o) => s + o.amountPaise, 0);
  const conservativeLift = Math.max(0, current.lowerPp / 100);
  const pointLift = Math.max(0, current.estimatePp / 100);

  const series = downsample(all, provenAt ? (provenAt as { index: number }).index : null);

  const common = {
    ...base,
    current,
    provenAt,
    controlAfterProof: afterProof.length,
    forgoneAfterProofPaise: Math.round(atRisk * conservativeLift),
    forgoneAfterProofPointPaise: Math.round(atRisk * pointLift),
    series,
  };

  if (provenAt && provenDirection === "benefit") {
    const p = provenAt as NonNullable<PriceOfProofReport["provenAt"]>;
    return {
      ...common,
      verdict: "proven",
      reason:
        `The lift was proven at event ${p.index} of ${input.length}, with a lower bound of ` +
        `${p.lowerPp.toFixed(1)}pp that holds however often the result was checked. ` +
        `${afterProof.length} control customers were held out after that point, buying certainty that was already established.`,
    };
  }

  if (provenAt && provenDirection === "harm") {
    const p = provenAt as NonNullable<PriceOfProofReport["provenAt"]>;
    return {
      ...common,
      verdict: "harm",
      reason:
        `Treatment was proven worse than doing nothing at event ${p.index} (upper bound ${p.upperPp.toFixed(1)}pp). ` +
        "The control arm is the one to keep; the agent should stop acting.",
    };
  }

  return {
    ...common,
    verdict: "not_yet",
    reason:
      `Not proven yet: the interval runs from ${current.lowerPp.toFixed(1)}pp to ${current.upperPp.toFixed(1)}pp after ${input.length} events. ` +
      "The holdout is still buying information, so it is still worth what it costs.",
  };
}

function downsample(points: ProofPoint[], keepIndex: number | null): ProofPoint[] {
  if (points.length <= MAX_SERIES_POINTS) return points;
  const step = points.length / MAX_SERIES_POINTS;
  const picked = new Map<number, ProofPoint>();
  for (let k = 0; k < MAX_SERIES_POINTS; k++) {
    const p = points[Math.floor(k * step)];
    picked.set(p.index, p);
  }
  const lastPoint = points[points.length - 1];
  picked.set(lastPoint.index, lastPoint);
  if (keepIndex !== null) picked.set(keepIndex, points[keepIndex - 1]);
  return [...picked.values()].sort((a, b) => a.index - b.index);
}
