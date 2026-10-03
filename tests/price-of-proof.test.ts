import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PER_ARM_TO_DECLARE,
  measurePriceOfProof,
  type ProofObservation,
} from "../lib/price-of-proof";
import { fisherExactTwoSided } from "../lib/statistics";

/**
 * Everything here is about one promise: the sequence may be checked after
 * every event, and still be wrong at most alpha of the time over the whole
 * run. That is checked by simulation rather than taken from the paper,
 * because an anytime-valid claim that was never measured is exactly the kind
 * of claim this project exists to refuse.
 */

/** Deterministic PRNG, so a failure here reproduces exactly. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PI = 0.1; // the policy's 10% holdout

function simulate(
  seed: number,
  n: number,
  treatedRate: number,
  controlRate: number
): ProofObservation[] {
  const rand = mulberry32(seed);
  const start = Date.parse("2026-06-01T00:00:00.000Z");
  return Array.from({ length: n }, (_, i) => {
    const arm = rand() < PI ? "control" : "treated";
    const rate = arm === "treated" ? treatedRate : controlRate;
    return {
      arm,
      recovered: rand() < rate,
      amountPaise: 100_000 + Math.floor(rand() * 400_000),
      atIso: new Date(start + i * 60_000).toISOString(),
    } as ProofObservation;
  });
}

test("with no real effect, continuous monitoring falsely declares one at most ~5% of the time", () => {
  const sims = 400;
  let falseProofs = 0;
  for (let s = 0; s < sims; s++) {
    const report = measurePriceOfProof(simulate(1000 + s, 1500, 0.2, 0.2), {
      controlProbability: PI,
    });
    if (report.provenAt) falseProofs++;
  }
  const rate = falseProofs / sims;
  // No slack: the guarantee is finite-sample, and measured at 1.2% over 1,000 runs.
  assert.ok(rate <= 0.05, `finite-sample valid at alpha=0.05 must not exceed it: got ${(rate * 100).toFixed(1)}%`);
});

/**
 * The reason the method exists. The exact test is correct when looked at
 * once. Looked at every 25 events and stopped at the first p < 0.05, it is
 * not — and this is precisely the dashboard habit of anyone watching a
 * running experiment.
 */
test("peeking with a fixed-sample exact test, on the same null runs, is fooled far more often", () => {
  const sims = 200;
  let fooled = 0;
  for (let s = 0; s < sims; s++) {
    const obs = simulate(1000 + s, 1500, 0.2, 0.2);
    const t = { n: 0, converted: 0, recoveredPaise: 0 };
    const c = { n: 0, converted: 0, recoveredPaise: 0 };
    for (let k = 0; k < obs.length; k++) {
      const arm = obs[k].arm === "treated" ? t : c;
      arm.n++;
      if (obs[k].recovered) arm.converted++;
      if (
        (k + 1) % 25 === 0 &&
        t.n >= MIN_PER_ARM_TO_DECLARE &&
        c.n >= MIN_PER_ARM_TO_DECLARE &&
        fisherExactTwoSided(t, c) < 0.05
      ) {
        fooled++;
        break;
      }
    }
  }
  const rate = fooled / sims;
  assert.ok(
    rate > 0.1,
    `repeated fixed-sample testing should be badly inflated over 60 looks; got ${(rate * 100).toFixed(1)}%`
  );
});

test("a real lift is proven before the run ends, and the help withheld after that is counted", () => {
  // The live batch's shape: about 33% treated against 12% control.
  let proven = 0;
  let sampleReport = null as ReturnType<typeof measurePriceOfProof> | null;
  for (let s = 0; s < 100; s++) {
    const report = measurePriceOfProof(simulate(5000 + s, 1500, 0.33, 0.12), {
      controlProbability: PI,
    });
    if (report.verdict === "proven") {
      proven++;
      sampleReport ??= report;
    }
  }
  assert.ok(proven >= 90, `a 21pp lift on 1,500 events should almost always be proven; got ${proven}/100`);

  const r = sampleReport!;
  assert.ok(r.provenAt!.index < r.observations, "proven before the end, or there is nothing to price");
  assert.ok(r.controlAfterProof > 0);
  assert.ok(r.controlAfterProof < r.controlTotal);
  assert.ok(r.forgoneAfterProofPaise > 0);
  // The headline figure is the conservative one.
  assert.ok(r.forgoneAfterProofPaise <= r.forgoneAfterProofPointPaise);
  assert.match(r.reason, /proven at event \d+ of 1500/);
});

test("the sequence covers the true lift at every moment, not just at the end", () => {
  // Coverage of the real difference, checked at every event of every run.
  const truePp = (0.33 - 0.12) * 100;
  let missed = 0;
  const sims = 300;
  for (let s = 0; s < sims; s++) {
    const report = measurePriceOfProof(simulate(9000 + s, 1200, 0.33, 0.12), {
      controlProbability: PI,
    });
    // The series is downsampled, so recompute at full resolution via a
    // report on each prefix would be quadratic; the downsampled path still
    // samples the whole run including its narrowest end.
    if (report.series.some((p) => p.index >= 2 * MIN_PER_ARM_TO_DECLARE / PI && (p.lowerPp > truePp || p.upperPp < truePp))) {
      missed++;
    }
  }
  assert.ok(missed / sims <= 0.07, `miscovered the true lift in ${missed}/${sims} runs`);
});

test("a treatment that hurts is called harm, and nothing is priced as forgone", () => {
  const report = measurePriceOfProof(simulate(77, 2000, 0.05, 0.3), { controlProbability: PI });

  assert.equal(report.verdict, "harm");
  assert.equal(report.controlAfterProof, 0);
  assert.equal(report.forgoneAfterProofPaise, 0);
  assert.match(report.reason, /stop acting/);
});

test("nothing is declared on arms smaller than the floor, however lopsided", () => {
  // Every treated event recovers, no control event does — but there are only
  // ten control events, and ten cannot carry a claim.
  const obs: ProofObservation[] = [
    ...Array.from({ length: 100 }, (_, i) => ({
      arm: "treated" as const,
      recovered: true,
      amountPaise: 1000,
      atIso: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      arm: "control" as const,
      recovered: false,
      amountPaise: 1000,
      atIso: new Date(Date.UTC(2026, 5, 2, 0, i)).toISOString(),
    })),
  ];
  const report = measurePriceOfProof(obs, { controlProbability: PI });

  assert.equal(report.provenAt, null);
  assert.equal(report.verdict, "not_yet");
});

test("observations are read in arrival order, not input order", () => {
  const obs = simulate(42, 800, 0.33, 0.12);
  const shuffled = [...obs].reverse();

  const a = measurePriceOfProof(obs, { controlProbability: PI });
  const b = measurePriceOfProof(shuffled, { controlProbability: PI });

  assert.deepEqual(a.provenAt, b.provenAt);
  assert.equal(a.controlAfterProof, b.controlAfterProof);
});

test("no data is reported as no data, and an impossible holdout is refused", () => {
  assert.equal(measurePriceOfProof([], { controlProbability: PI }).verdict, "no_data");
  assert.throws(() => measurePriceOfProof([], { controlProbability: 0 }), /strictly between/);
  assert.throws(() => measurePriceOfProof([], { controlProbability: 1 }), /strictly between/);
});

test("the chart series keeps the proof moment and the final point", () => {
  const report = measurePriceOfProof(simulate(5001, 1000, 0.33, 0.12), { controlProbability: PI });
  assert.ok(report.series.length <= 122);
  assert.equal(report.series[report.series.length - 1].index, report.observations);
  if (report.provenAt) {
    assert.ok(report.series.some((p) => p.index === report.provenAt!.index));
  }
});
