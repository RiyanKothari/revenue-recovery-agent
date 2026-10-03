import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BladeProvider } from "@razorpay/blade/components";
import { bladeTheme } from "@razorpay/blade/tokens";
import {
  measurePriceOfProof,
  type PriceOfProofReport,
  type ProofObservation,
} from "../lib/price-of-proof";
import { PriceOfProofCard } from "../app/dashboard/price-of-proof";

// JSX is "preserve" for Next, so components compile to the classic
// React.createElement and need React in scope under Node. Read at render
// time, so setting it after the hoisted imports is early enough.
(globalThis as any).React = React;

/**
 * The Price of Proof card, rendered the way the app renders it: inside
 * BladeProvider with the dark theme, which is what app/providers.tsx does.
 * Without the provider Blade has no tokens to read and throws before
 * drawing anything, which is why this card went untested while the chart
 * beside it (proof-band.test.ts) did not.
 *
 * Every verdict the library can return is rendered once, because the card
 * branches on all four and a branch nobody renders is a branch nobody knows
 * still works.
 */

function render(report: PriceOfProofReport): string {
  return renderToStaticMarkup(
    React.createElement(
      BladeProvider,
      { themeTokens: bladeTheme, colorScheme: "dark" } as any,
      React.createElement(PriceOfProofCard, { report })
    )
  );
}

/** Visible text, tags stripped, so assertions read like what a judge sees. */
const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

function batch(n: number, treatedRate: number, controlRate: number): ProofObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const control = i % 10 === 0;
    return {
      arm: control ? "control" : "treated",
      recovered: (i * 7919) % 100 < (control ? controlRate : treatedRate) * 100,
      amountPaise: 250_000,
      atIso: new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString(),
    } as ProofObservation;
  });
}

test("a proven run shows when, how many were held out after, and the conservative price first", () => {
  const report = measurePriceOfProof(batch(1500, 0.4, 0.05), { controlProbability: 0.1 });
  assert.equal(report.verdict, "proven", "fixture must actually prove the lift");

  const shown = text(render(report));

  assert.match(shown, /PRICE OF PROOF/);
  assert.match(shown, /Proven/);
  assert.match(shown, new RegExp(`Event ${report.provenAt!.index.toLocaleString("en-IN")}`));
  assert.match(shown, /of 1,500: when the lift was proven/);
  assert.match(
    shown,
    new RegExp(`${report.controlAfterProof} customers of ${report.controlTotal} held out after it was already proven`)
  );

  // The headline price is the lower-bound one, marked as a floor, and it
  // comes before the point estimate so the flattering number is never read
  // first.
  const floor = `≥ ₹${Math.round(report.forgoneAfterProofPaise / 100).toLocaleString("en-IN")}`;
  const point = `₹${Math.round(report.forgoneAfterProofPointPaise / 100).toLocaleString("en-IN")}`;
  assert.ok(shown.includes(floor), `expected the floor ${floor}`);
  assert.ok(shown.indexOf(floor) < shown.lastIndexOf(point), "conservative figure first");
  assert.match(shown, /at the lower bound/);

  // The method and its reason are stated on the card, not left to a README.
  assert.match(shown, /anytime-valid 95% confidence sequence \(empirical-Bernstein\)/);
  assert.match(shown, /about one time in five/);
  assert.match(render(report), /<svg/);
});

test("an unproven run says it is still learning and prices nothing", () => {
  const report = measurePriceOfProof(batch(200, 0.2, 0.2), { controlProbability: 0.1 });
  assert.equal(report.verdict, "not_yet");

  const shown = text(render(report));

  assert.match(shown, /Still learning/);
  assert.match(shown, /still worth what it costs/);
  assert.doesNotMatch(shown, /when the lift was proven/);
  assert.doesNotMatch(shown, /≥ ₹/, "no price for a holdout that has not finished its job");
});

test("a harmful treatment is called harm, and the price figures are not shown", () => {
  const report = measurePriceOfProof(batch(2000, 0.02, 0.4), { controlProbability: 0.1 });
  assert.equal(report.verdict, "harm", "fixture must actually prove harm");

  const shown = text(render(report));

  assert.match(shown, /Harm proven/);
  assert.match(shown, /stop acting/);
  assert.doesNotMatch(shown, /held out after it was already proven/);
});

test("no data renders a card with no chart and no figures, rather than an empty axis", () => {
  const report = measurePriceOfProof([], { controlProbability: 0.1 });
  const html = render(report);

  assert.match(text(html), /No data/);
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(text(html), /NaN|undefined|Infinity/);
});

test("no verdict ever renders NaN, undefined or Infinity", () => {
  const reports = [
    measurePriceOfProof(batch(1500, 0.4, 0.05), { controlProbability: 0.1 }),
    measurePriceOfProof(batch(200, 0.2, 0.2), { controlProbability: 0.1 }),
    measurePriceOfProof(batch(2000, 0.02, 0.4), { controlProbability: 0.1 }),
    measurePriceOfProof(batch(1, 1, 1), { controlProbability: 0.1 }),
  ];
  for (const report of reports) {
    assert.doesNotMatch(text(render(report)), /NaN|undefined|Infinity/, report.verdict);
  }
});
