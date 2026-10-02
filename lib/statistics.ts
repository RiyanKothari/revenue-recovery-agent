/**
 * The statistics behind every measured claim in this system.
 *
 * Split out from `experiment.ts` rather than left beside it, because that
 * module imports `node:crypto` for the holdout hash and these functions do
 * not need it. The cost of the coupling was concrete: the Attest console is a
 * client component, and pulling one confidence interval into the browser
 * dragged `node:crypto` into the bundle, where webpack refuses the `node:`
 * scheme outright. Arithmetic has no business being unbundleable.
 *
 * `experiment.ts` re-exports everything here, so nothing that already imported
 * these from there has to change.
 */

/**
 * Log-gamma, Lanczos approximation (g=7, n=9). Accurate to ~15 significant
 * digits across the range this file uses it for, which is factorials of event
 * counts. Present only so the exact test below can work with log-factorials
 * instead of factorials — `C(800, 400)` overflows a double, its logarithm does
 * not.
 */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z: number): number {
  if (z < 0.5) {
    // Reflection, so the series is only ever evaluated where it converges.
    return (
      Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
    );
  }
  const x = z - 1;
  let series = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) series += LANCZOS[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(series);
}

const logChoose = (n: number, k: number) =>
  logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);

/**
 * Fisher's exact test, two-sided, on the 2x2 table of (arm x converted).
 *
 * This decides `significant`, rather than asking whether a normal-approximation
 * interval clears zero. The approximation is not merely imprecise on small
 * arms, it is anticonservative in exactly the direction that manufactures
 * findings: three treated events that all converted against three control
 * events that all did not yields an interval of [+10pp, +100pp] under
 * Agresti-Caffo and would read as a result, while the exact probability of
 * seeing a split that extreme by chance alone is 0.10 — not significant by any
 * conventional threshold. Agresti-Caffo widened the interval enough to stop
 * one-against-one from being called a finding; it does not fix the general
 * case, because no amount of widening turns an approximation into an exact
 * count of the possible tables.
 *
 * Exact means exact: it enumerates every table with the same row and column
 * totals and sums the hypergeometric probability of those no more likely than
 * the one observed. Correct at n=1 and n=50,000 alike, with no threshold that
 * has to be guessed at and no regime where it quietly stops applying.
 *
 * The interval stays Agresti-Caffo. The two answer different questions — how
 * large is the effect, and could there be no effect — and a reader is better
 * served by the best available answer to each than by one method forced to do
 * both jobs.
 *
 * Cost is one pass over the possible values of the treated-and-converted cell,
 * bounded by the smaller of the arm size and the conversion total. At the
 * volumes here that is thousands of log-gamma evaluations, microseconds, and it
 * runs once per comparison rather than once per event.
 */
export function fisherExactTwoSided(treated: ArmOutcome, control: ArmOutcome): number {
  const total = treated.n + control.n;
  const converted = treated.converted + control.converted;

  // No variation in either margin: every table with these totals is the one
  // observed, so nothing about it is surprising.
  if (total === 0 || converted === 0 || converted === total) return 1;
  if (treated.n === 0 || control.n === 0) return 1;

  const logDenominator = logChoose(total, converted);
  const probability = (a: number) =>
    Math.exp(
      logChoose(treated.n, a) + logChoose(control.n, converted - a) - logDenominator
    );

  const lo = Math.max(0, converted - control.n);
  const hi = Math.min(treated.n, converted);

  // A relative slack, because two tables that are equally likely in exact
  // arithmetic can differ in the last bits after exp() — and dropping the
  // mirror image of the observed table would halve the p-value of precisely
  // the symmetric cases this test exists to be trusted on.
  const observed = probability(treated.converted) * (1 + 1e-9);

  let p = 0;
  for (let a = lo; a <= hi; a++) {
    const pa = probability(a);
    if (pa <= observed) p += pa;
  }

  return Math.min(1, p);
}

export interface ArmOutcome {
  /** Eligible events assigned to this arm. */
  n: number;
  /** How many of them were ultimately recovered. */
  converted: number;
  /** Total recovered, in paise. */
  recoveredPaise: number;
}

export interface LiftResult {
  treatedRate: number;
  controlRate: number;
  /** Percentage points, treated minus control. */
  absoluteLiftPp: number;
  relativeLift: number | null;
  /** 95% CI on the absolute lift, in percentage points. */
  ci95Pp: [number, number] | null;
  /**
   * Recovered money the agent can actually claim: what treated brought in,
   * minus what the same number of untreated events would have brought in on
   * their own.
   */
  incrementalPaise: number | null;
  /**
   * Whether chance alone is an inadequate explanation of the difference, by
   * Fisher's exact test at alpha 0.05 two-sided. Not read off the interval —
   * see `fisherExactTwoSided` for why the interval is the wrong instrument for
   * this question.
   */
  significant: boolean;
  /** The exact two-sided p-value behind `significant`. Null with no control arm. */
  pValue: number | null;
  /** Populated when the arms are too small to say anything. */
  caveat?: string;
}

/**
 * Two-proportion comparison with a normal-approximation interval.
 *
 * Deliberately reports a CI rather than a bare p-value: with a few hundred
 * events the honest answer is usually "somewhere between +4 and +21 points",
 * and collapsing that to "significant" hides how wide it still is.
 *
 * The interval is Agresti-Caffo, not textbook Wald, and the difference is not
 * academic. Wald's standard error is built from the observed rates, so an arm
 * sitting on 0% or 100% contributes exactly zero variance — the arm looks
 * perfectly certain because it never varied. One treated event that recovered
 * against one control event that did not produced a 95% interval of
 * [+100pp, +100pp]: zero width, and `significant` came back true off two
 * observations. Every caller treats that flag as a finding. The fairness audit
 * reports a disparity against a protected segment, the unlearning verifier
 * reports residual influence from data that was supposed to be forgotten, the
 * reality check calls the simulator miscalibrated, and the dashboard paints a
 * green chip. All of them from a sample that cannot support any claim at all.
 *
 * Adding one notional success and one notional failure to each arm before
 * computing the standard error fixes it at the root: no arm can land on a
 * boundary, so the variance is strictly positive and the interval always has
 * width. Nothing is traded away for it — Agresti-Caffo holds its nominal 95%
 * coverage better than Wald at every sample size, not just small ones.
 *
 * The point estimate stays the observed difference. The adjustment exists to
 * make the uncertainty honest, not to move the number being reported.
 */
export function computeLift(treated: ArmOutcome, control: ArmOutcome): LiftResult {
  const empty: LiftResult = {
    treatedRate: 0,
    controlRate: 0,
    absoluteLiftPp: 0,
    relativeLift: null,
    ci95Pp: null,
    incrementalPaise: null,
    significant: false,
    pValue: null,
    caveat: "No control arm yet — lift cannot be measured.",
  };

  if (treated.n === 0 || control.n === 0) return empty;

  const treatedRate = treated.converted / treated.n;
  const controlRate = control.converted / control.n;
  const diff = treatedRate - controlRate;

  // Agresti-Caffo: each arm gets one notional success and one notional
  // failure, so neither rate can sit on a boundary and the standard error is
  // strictly positive for any n >= 1. See the note above this function for
  // what the unadjusted version did to a one-against-one comparison.
  const adjTreated = (treated.converted + 1) / (treated.n + 2);
  const adjControl = (control.converted + 1) / (control.n + 2);
  const adjDiff = adjTreated - adjControl;

  const se = Math.sqrt(
    (adjTreated * (1 - adjTreated)) / (treated.n + 2) +
      (adjControl * (1 - adjControl)) / (control.n + 2)
  );

  const margin = 1.96 * se;

  // A difference of two proportions cannot leave [-100pp, +100pp]; the normal
  // approximation does not know that and will happily print +108. Clamping
  // cannot change the significance verdict, since it only ever pulls a bound
  // toward zero from outside the possible range, never across zero.
  const clampPp = (v: number) => Math.max(-100, Math.min(100, v));
  const ciLow = clampPp((adjDiff - margin) * 100);
  const ciHigh = clampPp((adjDiff + margin) * 100);
  const intervalExcludesZero = ciLow > 0 || ciHigh < 0;

  // Value per untreated event is the baseline; anything above it is the
  // agent's doing. Using recovered-per-event rather than a conversion rate
  // times an average keeps varying ticket sizes honest.
  const baselinePerEvent = control.recoveredPaise / control.n;
  const incrementalPaise = Math.round(
    treated.recoveredPaise - baselinePerEvent * treated.n
  );

  // The verdict comes from the exact test, not from whether the interval
  // above clears zero. The interval describes the size of the effect; this
  // answers whether there is one.
  const pValue = fisherExactTwoSided(treated, control);

  // Under ~30 per arm the normal approximation is doing more work than the
  // data supports; say so rather than printing a confident interval. The
  // verdict is unaffected — Fisher's test is exact at any size — but the
  // interval shown beside it is still only an approximation.
  const underpowered = treated.n < 30 || control.n < 30;

  /**
   * Where the approximation contradicts the exact test, the approximation is
   * the one that is wrong, and it is withheld rather than printed with a
   * footnote.
   *
   * An interval of [+10pp, +100pp] sitting beside "not significant" does not
   * read as two methods answering two questions. It reads as a contradiction,
   * and a reader resolves a contradiction by believing whichever half suits
   * them — here, the half that excludes zero and looks like a result. The
   * dashboard draws the interval against a zero line precisely so that
   * excluding zero is visible at a glance, which makes the misread effortless.
   *
   * This only ever fires on arms small enough that the normal approximation
   * has overstated its own precision; the exact p-value is still reported, so
   * nothing measured is lost, only a number that would mislead. The same
   * choice the conformance verifier makes when it refuses to attest over a
   * subset rather than passing on rows nobody checked.
   */
  const intervalOverstatesPrecision = intervalExcludesZero && pValue >= 0.05;

  const caveat = underpowered
    ? `Small arms (treated n=${treated.n}, control n=${control.n}) — ` +
      (intervalOverstatesPrecision
        ? `too small for an interval: the normal approximation excludes zero here, but an exact test puts the probability of a split this lopsided arising by chance at ${(pValue * 100).toFixed(0)}%. Directional at most.`
        : "the interval is wide and this is directional, not conclusive.")
    : undefined;

  return {
    treatedRate,
    controlRate,
    absoluteLiftPp: diff * 100,
    relativeLift: controlRate > 0 ? diff / controlRate : null,
    ci95Pp: intervalOverstatesPrecision ? null : [ciLow, ciHigh],
    incrementalPaise,
    significant: pValue < 0.05,
    pValue,
    caveat,
  };
}


/**
 * The smallest effect this experiment could actually have detected.
 *
 * Without it, "not significant" is ambiguous in the worst way: it reads as
 * "the agent did not work" when it often means "this holdout was never large
 * enough to tell". A 10% holdout of four hundred events yields about thirty
 * control observations, and thirty observations cannot resolve a fifteen
 * point difference — the experiment was underpowered before it ran, which is
 * a fact about the design rather than a finding about the agent.
 *
 * Reporting the minimum detectable effect alongside the result turns a
 * confusing null into a specific, actionable statement: either the effect is
 * smaller than this, or the holdout needs to be bigger. Anyone reading the
 * panel can then tell which question the data has answered.
 *
 * Standard two-proportion power calculation at 80% power, alpha 0.05
 * two-sided, evaluated at the rate pooled across both arms.
 *
 * Pooled rather than control-only, because the control-only variance is zero
 * whenever the control arm converted nobody — and that is not an exotic case,
 * it is what a small holdout looks like early on. The old guard against a zero
 * variance returned null, which switched off the whole explanation at the one
 * moment it was most needed: the dashboard's "this holdout can only resolve
 * Npp" line is rendered only when this value is non-null, so a control arm of
 * 0/40 produced a bare "not significant" with nothing to say why, and the
 * fairness audit printed the literal string "?pp" into its reasoning.
 *
 * Pooling is also what the two-proportion test statistic itself uses, so the
 * power calculation and the test it describes now rest on the same variance.
 * Null is reserved for the case where pooling cannot help either: no arm
 * converted anyone, or every arm converted everyone, where there is genuinely
 * no variation anywhere to estimate a detectable difference from.
 */
const Z_ALPHA = 1.959964; // two-sided 95%
const Z_POWER = 0.8416212; // 80% power

export interface PowerResult {
  /** Smallest true difference detectable at 80% power, in percentage points. */
  minimumDetectableEffectPp: number | null;
  /** Control observations needed to detect the effect actually observed. */
  controlNeededForObserved: number | null;
  /** True when the arms are large enough to resolve the observed difference. */
  adequatelyPowered: boolean;
  /**
   * False when the minimum detectable effect exceeds the 100pp that a
   * difference of two rates can physically span — the comparison can resolve
   * no effect that could exist, and the number is a way of saying "nothing"
   * rather than a sensitivity.
   *
   * Carried here rather than left to each caller to notice, because the two
   * places that print the MDE both phrase it as "can resolve an effect of
   * Npp or larger", and on single-digit arms N comes out at 114 or 198. That
   * sentence is not wrong so much as self-discrediting: a reader who spots an
   * impossible percentage stops trusting the panel, and this panel's whole
   * purpose is to be the trustworthy one. Anything comparing the MDE against
   * a materiality threshold is unaffected either way, since a value above 100
   * already fails every threshold.
   */
  resolvesAnyPossibleEffect: boolean;
}

/**
 * The sensitivity as a noun phrase, for the places that report a null result
 * by naming what the test could have seen.
 *
 * Centralised because every one of those sentences was built by hand around
 * `.toFixed(1)}pp`, and on small arms the value is 114 or 198 — a percentage
 * point difference larger than the 100 that two rates can differ by at all.
 * Each site would have had to notice that independently; one of them already
 * interpolated the literal string `"?pp"` for the null case. Drops into "could
 * only have resolved an advantage of ___".
 */
export function describeSensitivity(minimumDetectableEffectPp: number | null): string {
  if (minimumDetectableEffectPp === null) return "an amount it cannot establish";
  if (minimumDetectableEffectPp > 100) {
    return "no difference that could exist — its sensitivity is coarser than the full 100pp two rates can differ by";
  }
  return `about ${minimumDetectableEffectPp.toFixed(1)}pp`;
}

export function assessPower(treated: ArmOutcome, control: ArmOutcome): PowerResult {
  if (treated.n === 0 || control.n === 0) {
    return {
      minimumDetectableEffectPp: null,
      controlNeededForObserved: null,
      adequatelyPowered: false,
      resolvesAnyPossibleEffect: false,
    };
  }

  const controlRate = control.converted / control.n;

  const pooled =
    (treated.converted + control.converted) / (treated.n + control.n);
  const variance = pooled * (1 - pooled);

  // Harmonic mean of the arm sizes — the effective sample size when the two
  // are unequal, which they always are with a small holdout.
  const nEff = (2 * treated.n * control.n) / (treated.n + control.n);

  if (nEff <= 0 || variance <= 0) {
    return {
      minimumDetectableEffectPp: null,
      controlNeededForObserved: null,
      adequatelyPowered: false,
      resolvesAnyPossibleEffect: false,
    };
  }

  const mde = (Z_ALPHA + Z_POWER) * Math.sqrt((2 * variance) / nEff);

  const observed = Math.abs(treated.converted / treated.n - controlRate);
  const ratio = treated.n / control.n;

  // Control observations required to detect the difference actually seen,
  // holding the current allocation ratio.
  const needed =
    observed > 0
      ? Math.ceil(
          (((Z_ALPHA + Z_POWER) ** 2) * variance * (1 + 1 / ratio)) / observed ** 2
        )
      : null;

  return {
    minimumDetectableEffectPp: mde * 100,
    controlNeededForObserved: needed,
    adequatelyPowered: needed !== null && control.n >= needed,
    resolvesAnyPossibleEffect: mde * 100 <= 100,
  };
}
