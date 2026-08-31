import fs from "node:fs";
import path from "node:path";

/**
 * Next.js loads .env.local automatically, but standalone tsx scripts do not.
 * Without this, `npm run seed:batch` throws "RAZORPAY_WEBHOOK_SECRET not set"
 * on a fully configured machine — the script reads process.env, and nothing
 * had ever put .env.local into it.
 *
 * Deliberately dependency-free: real values already live in .env.local for
 * Next's sake, and adding dotenv just to re-read the same file isn't worth a
 * package. Existing environment variables always win, so CI and shell
 * overrides behave the way you'd expect.
 */
export function loadEnv(file = ".env.local"): boolean {
  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) return false;

  const contents = fs.readFileSync(fullPath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    // Comment and blank lines simply never match.
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    // Strip matched surrounding quotes, leaving inner characters untouched —
    // a secret containing '#' or '=' must survive this.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}
