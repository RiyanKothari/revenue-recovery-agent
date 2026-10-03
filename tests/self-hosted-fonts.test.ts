import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * The build must not fetch fonts. next/font/google downloads them at build
 * time, so a CI run once failed inside next/font with no code changed and a
 * re-run passed — a build that can fail on someone else's server, possibly on
 * the day it matters. The fonts now ship in app/fonts through next/font/local.
 *
 * These read the source rather than run a build, because the failure they
 * guard against is a one-line import that compiles and builds fine for as
 * long as Google happens to answer.
 */

const root = join(__dirname, "..");
const layoutPath = join(root, "app", "layout.tsx");
const layout = readFileSync(layoutPath, "utf8");

test("no source file loads fonts from Google", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) {
        const body = readFileSync(full, "utf8");
        if (/next\/font\/google|fonts\.(googleapis|gstatic)\.com/.test(body)) offenders.push(full);
      }
    }
  };
  walk(join(root, "app"));
  assert.deepEqual(offenders, [], "fonts must be self-hosted; see app/layout.tsx");
});

test("the layout loads its font through next/font/local", () => {
  assert.match(layout, /from "next\/font\/local"/);
});

test("every font file the layout names exists, is a real WOFF2, and has its licence beside it", () => {
  const paths = [...layout.matchAll(/path:\s*"([^"]+\.woff2)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 2, `expected the 400 and 500 weights, found ${paths.length}`);

  for (const rel of paths) {
    const file = join(dirname(layoutPath), rel);
    assert.ok(existsSync(file), `missing font file: ${rel}`);
    // Every WOFF2 file begins with the signature "wOF2"; a renamed TTF or an
    // HTML error page saved with the right extension does not.
    assert.equal(readFileSync(file).subarray(0, 4).toString("latin1"), "wOF2", `${rel} is not WOFF2`);
  }

  const licence = join(root, "app", "fonts", "OFL.txt");
  assert.ok(existsSync(licence), "the OFL requires the licence to travel with the font");
  assert.match(readFileSync(licence, "utf8"), /SIL Open Font License/);
});

test("the font still feeds the variable the stylesheet uses", () => {
  // globals.css styles the ledger register through var(--font-mono); a
  // renamed variable would silently fall back to the system monospace.
  assert.match(layout, /variable:\s*"--font-mono"/);
  assert.match(readFileSync(join(root, "app", "globals.css"), "utf8"), /var\(--font-mono\)/);
});
