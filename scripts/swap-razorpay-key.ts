import { loadEnv } from "./load-env";
import fs from "node:fs";
import path from "node:path";

/**
 * Swaps in a new Razorpay test key pair and derives everything that depends
 * on it.
 *
 * Exists because two of the three derived values are easy to get subtly
 * wrong, and both fail late rather than loudly:
 *
 *   - RAZORPAY_MCP_MERCHANT_TOKEN is base64 of "key_id:key_secret". Generating
 *     it with `echo` appends a newline, which base64 happily encodes and the
 *     MCP server then rejects with an auth error that names neither the
 *     newline nor the token.
 *
 *   - RAZORPAY_MCP_LINK_BUDGET has to be raised off 0, or the pipeline keeps
 *     marking every link simulated against an account that now has quota.
 *
 * Run after pasting the new RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET into
 * .env.local:
 *
 *   npx tsx scripts/swap-razorpay-key.ts
 */

loadEnv();

const ENV_PATH = path.join(process.cwd(), ".env.local");

function setVar(source: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

  if (!keyId || !keySecret) {
    console.error("Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.local first.");
    process.exit(1);
  }

  if (!keyId.startsWith("rzp_test_")) {
    console.error(
      `RAZORPAY_KEY_ID is "${keyId.slice(0, 9)}…" — that is not a test key. Live keys move real money; refusing.`
    );
    process.exit(1);
  }

  // --- 1. Does the key actually work?
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/payment_links?count=100", {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    console.error(`Razorpay rejected the key pair (HTTP ${res.status}). Check both values.`);
    process.exit(1);
  }

  const body: any = await res.json();
  const links: any[] = body.payment_links ?? body.items ?? [];
  const remaining = Math.max(0, 30 - links.length);

  console.log(`Key authenticates. ${links.length} payment links used, ${remaining} of 30 remaining.`);

  // --- 2. Derive the MCP token from the SAME strings, with no newline.
  let source = fs.readFileSync(ENV_PATH, "utf8");
  source = setVar(source, "RAZORPAY_MCP_MERCHANT_TOKEN", auth);

  /**
   * Leave headroom rather than spending the whole allowance. A demo where a
   * judge clicks a link needs quota left, and running out mid-recording is
   * unrecoverable in a way that running out afterwards is not.
   */
  const budget = Math.max(0, Math.min(25, remaining - 5));
  source = setVar(source, "RAZORPAY_MCP_LINK_BUDGET", String(budget));

  fs.writeFileSync(ENV_PATH, source, "utf8");

  console.log(`Wrote RAZORPAY_MCP_MERCHANT_TOKEN (${auth.length} chars, no trailing newline).`);
  console.log(`Set RAZORPAY_MCP_LINK_BUDGET=${budget} (keeping 5 links spare for the demo).`);
  console.log("\nNext: npm run preflight razorpay mcp");
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
