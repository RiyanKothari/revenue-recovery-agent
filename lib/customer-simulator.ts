import crypto from "crypto";
import type { ArmOutcome } from "./statistics";

/**
 * The simulated customers an agent is certified against.
 *
 * ## What this is, stated plainly
 *
 * This is a **stand-in** for the LLM user-simulator a certification pipeline
 * would really use, and it is not pretending otherwise. It exists so the
 * calibration loop has something to calibrate, in the same way the synthetic
 * batch exists so the holdout arithmetic has something to measure. What is
 * demonstrated is the machinery; what is not demonstrated is a real
 * simulator's behaviour.
 *
 * Saying that first matters here more than anywhere else in the project,
 * because there is an obvious way to cheat: build a simulator with a known
 * bias, then "discover" that bias with Reality Check and call it a finding.
 * That would be circular and worthless. The bias below is declared in the
 * source, deliberately, so nobody can mistake finding it for evidence about
 * real simulators.
 *
 * ## Why it is deterministic rather than a model call
 *
 * A certification harness that cannot run without a live model cannot run
 * during an outage, and is untestable besides. Seeded from the persona and
 * the agent version, so the same cohort always produces the same prediction
 * and a fidelity gap that moves means the agent moved.
 *
 * ## The bias it models, and why
 *
 * arXiv 2606.20708, across 2,790 real sales conversations: simulated
 * customers deliberate 75% of the time against 45% for real people, halve
 * expressed resistance for eventual non-buyers, and never walk away. The
 * shape that matters is that the error is **uneven** — it concentrates in
 * customers who would have declined. So `walkAwayRate` is what a real
 * population does and what a simulator systematically misses, and it is
 * applied per persona rather than globally.
 */

export interface Persona {
  segment: string;
  /**
   * How readily this persona converts when nothing gets in the way, 0 to 1.
   * The honest part of the model.
   */
  baseIntent: number;
  /**
   * The fraction who would abandon regardless of how good the offer is.
   *
   * This is the quantity a simulator cannot see. A real population contains
   * people who were never going to buy and who stop replying; a simulated one
   * keeps deliberating politely forever.
   */
  walkAwayRate: number;
  /** How many customers of this kind to simulate. */
  count: number;
}

export interface SimulationOptions {
  agentVersion: string;
  /**
   * Whether the simulator can see walk-away behaviour.
   *
   * False is the default and models the published finding: the simulator runs
   * the cohort as though nobody ever leaves, which inflates conversion by
   * roughly the walk-away rate and inflates it most where that rate is
   * highest.
   *
   * True exists so a test can show the same harness producing an unbiased
   * prediction, which is what proves the calibration layer is measuring the
   * bias rather than a constant baked into this file.
   */
  modelsWalkAway?: boolean;
}

/**
 * A stable pseudo-random draw in [0, 1) from a string.
 *
 * Hash-derived rather than a PRNG with mutable state, so simulating one
 * segment cannot change another's result depending on the order they ran —
 * the same reasoning as the holdout assignment being a pure function of the
 * event id.
 */
function draw(seed: string): number {
  const digest = crypto.createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Runs one persona cohort and returns what the simulator predicts.
 *
 * Returns an `ArmOutcome` so it drops straight into `computeLift` and
 * `assessPower` beside a real measured arm, with no adapter in between.
 */
export function simulateCohort(persona: Persona, options: SimulationOptions): ArmOutcome {
  const seesWalkAway = options.modelsWalkAway ?? false;

  let converted = 0;
  for (let i = 0; i < persona.count; i++) {
    const seed = `${options.agentVersion}:${persona.segment}:${i}`;

    if (seesWalkAway && draw(`walk:${seed}`) < persona.walkAwayRate) {
      // This customer left. A real one does; the published finding is that a
      // simulated one does not.
      continue;
    }

    if (draw(`intent:${seed}`) < persona.baseIntent) converted += 1;
  }

  return { n: persona.count, converted, recoveredPaise: 0 };
}

export interface SimulationRun {
  agentVersion: string;
  segments: { segment: string; predicted: ArmOutcome; predictedRate: number }[];
  /** Stated on every run so a consumer cannot forget which mode produced it. */
  modelsWalkAway: boolean;
}

export function simulate(personas: Persona[], options: SimulationOptions): SimulationRun {
  return {
    agentVersion: options.agentVersion,
    modelsWalkAway: options.modelsWalkAway ?? false,
    segments: personas.map((persona) => {
      const predicted = simulateCohort(persona, options);
      return {
        segment: persona.segment,
        predicted,
        predictedRate: predicted.n === 0 ? 0 : predicted.converted / predicted.n,
      };
    }),
  };
}

/**
 * A population whose walk-away rate varies sharply between segments.
 *
 * Not arbitrary. If every segment walked away at the same rate, a single
 * global correction would work and the per-segment machinery would be
 * pointless decoration. The published finding is specifically that the error
 * concentrates in customers who would have declined, so `reluctant` is the
 * segment that diverges and the well-modelled ones are also the larger ones —
 * which is exactly the shape that survives an aggregate review.
 */
export const DEFAULT_PERSONAS: Persona[] = [
  { segment: "browsers", baseIntent: 0.5, walkAwayRate: 0.04, count: 2000 },
  { segment: "loyal", baseIntent: 0.7, walkAwayRate: 0.02, count: 2000 },
  { segment: "reluctant", baseIntent: 0.6, walkAwayRate: 0.5, count: 400 },
];
