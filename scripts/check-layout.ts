/**
 * Checks that no page scrolls sideways on a phone, against a running site.
 *
 * Run with: npm run check:layout -- https://revenue-recovery-agent-plum.vercel.app
 *
 * Red Team shipped with rows 7px wider than a 375px screen, and nothing could
 * have caught it: layout is decided by the browser, by the real data on the
 * page, and by the viewport, none of which a unit test has. So this runs a
 * real Chrome against a real deployment — CI points it at production after
 * every successful deploy (.github/workflows/layout.yml).
 *
 * It drives the Chrome already installed on the machine (`channel: "chrome"`)
 * through playwright-core, which downloads no browser of its own. GitHub's
 * Ubuntu runners ship Chrome; so does the machine this was written on.
 */

import { chromium } from "playwright-core";

export interface LayoutPage {
  path: string;
  /** Text that only appears once the page has its data — an empty loading
   *  state cannot overflow, so checking it would pass meaninglessly. */
  readyText: string | RegExp;
  /** A control to press once ready, and what proves its result has rendered. */
  then?: { click: string | RegExp; readyText: string | RegExp };
}

export const PAGES: LayoutPage[] = [
  { path: "/dashboard", readyText: "PRICE OF PROOF" },
  // The replay's results table only exists after Replay is pressed, and a
  // table is the likeliest thing on any page to outgrow a phone.
  {
    path: "/dashboard/policy",
    readyText: "POLICY TUNING",
    then: { click: /Replay batch events/, readyText: "REPLAY FIDELITY" },
  },
  // Not "Red Team": that is also in the nav, which renders before the attack
  // results do — the first version of this check measured the page empty
  // and passed with the original 7px bug put back.
  { path: "/dashboard/redteam", readyText: /\d+\/\d+ held|\d+ breached/ },
  { path: "/attest", readyText: "Six agents running live" },
  { path: "/verify", readyText: "Check a payment message" },
];

/** The narrowest common phone, and the one Red Team broke on. */
export const WIDTHS = [320, 375];

export interface Measurement {
  path: string;
  width: number;
  scrollWidth: number;
  /** The widest offending elements, for the failure message. */
  offenders: string[];
}

/**
 * Whether a measurement is a sideways scroll. One pixel of slack: subpixel
 * rounding can report a document a fraction wider than the viewport without
 * anything being scrollable.
 */
export function overflows(m: Measurement): boolean {
  return m.scrollWidth > m.width + 1;
}

export function describe(m: Measurement): string {
  return overflows(m)
    ? `${m.width}px ${m.path}: ${m.scrollWidth - m.width}px too wide — ${m.offenders.join(", ") || "no single element found"}`
    : `${m.width}px ${m.path}: ok`;
}

/**
 * `injectCss` re-creates a regression inside the browser without deploying it,
 * which is how this checker is shown to catch the bug it was written for.
 */
export async function measure(
  baseUrl: string,
  options: { pages?: LayoutPage[]; widths?: number[]; injectCss?: string } = {}
): Promise<Measurement[]> {
  const pages = options.pages ?? PAGES;
  const widths = options.widths ?? WIDTHS;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const results: Measurement[] = [];
  try {
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      for (const target of pages) {
        await page.goto(new URL(target.path, baseUrl).toString(), { waitUntil: "load" });
        await page.getByText(target.readyText).first().waitFor({ timeout: 30_000 });
        if (target.then) {
          await page.getByText(target.then.click).first().click();
          await page.getByText(target.then.readyText).first().waitFor({ timeout: 30_000 });
        }
        if (options.injectCss) await page.addStyleTag({ content: options.injectCss });
        // Let late data (polling cards, charts) settle before measuring.
        await page.waitForTimeout(1500);
        const m = await page.evaluate((w) => {
          // Content inside a container that scrolls or clips horizontally is
          // allowed past the viewport; it is the container that must fit. Left
          // in, a correctly scrolling table hid the element actually pushing
          // the page out.
          // (No named helper: this body runs in the page, where the TypeScript
          // runner's __name shim for named functions does not exist.)
          const offenders = [...document.querySelectorAll("body *")]
            .map((el) => {
              let scrolled = false;
              for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") {
                  scrolled = true;
                  break;
                }
              }
              return { el, right: el.getBoundingClientRect().right, scrolled };
            })
            .filter(
              ({ el, right, scrolled }) =>
                right > w + 1 && (el as HTMLElement).offsetWidth > 0 && !scrolled
            )
            .sort((a, b) => b.right - a.right)
            .slice(0, 3)
            .map(({ el, right }) => {
              const cls = (el.getAttribute("class") ?? "").split(" ")[0];
              return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} to ${Math.round(right)}px`;
            });
          return { scrollWidth: document.documentElement.scrollWidth, offenders };
        }, width);
        results.push({ path: target.path, width, ...m });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

async function main() {
  const baseUrl = process.argv[2] ?? process.env.LAYOUT_BASE_URL;
  if (!baseUrl) {
    console.error("Usage: npm run check:layout -- <base url>");
    process.exit(2);
  }
  const results = await measure(baseUrl);
  for (const m of results) console.log(describe(m));
  const failed = results.filter(overflows);
  if (failed.length) {
    console.error(`\n${failed.length} page/width combination(s) scroll sideways on a phone.`);
    process.exit(1);
  }
  console.log(`\nNo sideways scroll on ${PAGES.length} pages at ${WIDTHS.join("px and ")}px.`);
}

// Run only when executed directly, so the test can import the pure parts.
if (process.argv[1] && /check-layout\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
