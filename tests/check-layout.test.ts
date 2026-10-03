import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGES, WIDTHS, describe, overflows, type Measurement } from "../scripts/check-layout";

/**
 * The judgement half of the layout check, which needs no browser. The
 * browser half runs in CI against production after each deploy, and was
 * shown to catch the original Red Team bug when it was re-injected.
 */

const m = (scrollWidth: number, width = 375): Measurement => ({
  path: "/dashboard/redteam",
  width,
  scrollWidth,
  offenders: scrollWidth > width ? ["div.rr-row to 383px"] : [],
});

test("the original Red Team bug counts as a sideways scroll", () => {
  assert.equal(overflows(m(382)), true, "7px over, as shipped");
  assert.match(describe(m(382)), /7px too wide — div\.rr-row/);
});

test("a page that fits, or rounds a pixel over, does not", () => {
  assert.equal(overflows(m(375)), false);
  assert.equal(overflows(m(360)), false, "narrower than the viewport is fine");
  assert.equal(overflows(m(376)), false, "one pixel of subpixel rounding is tolerated");
  assert.equal(overflows(m(377)), true, "two is not");
});

test("every page a judge can reach is checked, at the narrowest phone too", () => {
  const paths = PAGES.map((p) => p.path);
  for (const path of ["/dashboard", "/dashboard/policy", "/dashboard/redteam", "/attest", "/verify"]) {
    assert.ok(paths.includes(path), `${path} is not checked`);
  }
  assert.ok(WIDTHS.includes(320) && WIDTHS.includes(375));
});

test("no page is declared ready by text the nav shows before its data loads", () => {
  // The first version waited for "Red Team", which the nav renders at once,
  // so it measured an empty page and missed the bug it was written for.
  const navLabels = ["Overview", "Policy Lab", "Red Team", "Attest"];
  for (const p of PAGES) {
    if (typeof p.readyText === "string") {
      assert.ok(!navLabels.includes(p.readyText), `${p.path} waits for a nav label`);
    }
  }
});
