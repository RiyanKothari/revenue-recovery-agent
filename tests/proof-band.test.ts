import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { measurePriceOfProof, type ProofObservation } from "../lib/price-of-proof";

// tsconfig keeps JSX as "preserve" for Next, so the component compiles to the
// classic React.createElement and needs React in scope when run under Node.
(globalThis as any).React = React;

/**
 * The Price of Proof chart, rendered. Its axis reached production printing
 * "+31.818181818181817pp" because nothing ever drew it outside a browser.
 * These run against reports produced by the real library, so the chart is
 * tested on the shapes it will actually receive.
 */

function batch(n: number, treatedRate: number, controlRate: number): ProofObservation[] {
  // Deterministic: every tenth event is control, recoveries spread evenly.
  return Array.from({ length: n }, (_, i) => {
    const control = i % 10 === 0;
    const rate = control ? controlRate : treatedRate;
    return {
      arm: control ? "control" : "treated",
      recovered: (i * 7919) % 100 < rate * 100,
      amountPaise: 250_000,
      atIso: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString(),
    } as ProofObservation;
  });
}

async function render(report: ReturnType<typeof measurePriceOfProof>) {
  const { ProofBand } = await import("../app/dashboard/proof-band");
  return renderToStaticMarkup(React.createElement(ProofBand, { report }));
}

const labels = (html: string) =>
  [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test("axis labels are whole multiples of 10pp, never raw floating point", async () => {
  const report = measurePriceOfProof(batch(1000, 0.33, 0.12), { controlProbability: 0.1 });
  const html = await render(report);
  const axis = labels(html).filter((l) => /pp$/.test(l));

  assert.equal(axis.length, 2, `expected a top and bottom label, got ${axis}`);
  for (const label of axis) {
    assert.match(label, /^[+-]\d+0pp$/, `axis label must be a whole 10pp: ${label}`);
  }
});

test("a proven run draws the marker where the report says, and says so to a screen reader", async () => {
  const report = measurePriceOfProof(batch(1500, 0.4, 0.05), { controlProbability: 0.1 });
  assert.equal(report.verdict, "proven", "fixture must actually prove the lift");

  const html = await render(report);
  assert.ok(labels(html).includes("proven"));
  assert.match(html, new RegExp(`clearing zero at event ${report.provenAt!.index}\\.`));
});

test("an unproven run draws no marker and does not claim to have cleared zero", async () => {
  const report = measurePriceOfProof(batch(200, 0.2, 0.2), { controlProbability: 0.1 });
  assert.notEqual(report.verdict, "proven");

  const html = await render(report);
  assert.ok(!labels(html).includes("proven"));
  assert.match(html, /it has not cleared zero/);
});

test("the axis half-range rounds up, and stays within its clip", async () => {
  const { axisHalfRangePp } = await import("../app/dashboard/proof-band");

  assert.equal(axisHalfRangePp([21.818]), 40, "31.8 rounds up to 40, never prints raw");
  assert.equal(axisHalfRangePp([0]), 10, "the floor");
  assert.equal(axisHalfRangePp([95]), 60, "the clip");
  assert.equal(axisHalfRangePp([]), 10, "no data does not produce -Infinity");
  assert.equal(axisHalfRangePp([-50]), 10, "a negative estimate does not shrink below the floor");
});
