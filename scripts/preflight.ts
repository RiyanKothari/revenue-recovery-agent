/**
 * Checks every external dependency this project needs, and tells you exactly
 * what is wrong with each one.
 *
 * Five services have to line up before the pipeline does anything real, and
 * a misconfigured one usually surfaces as a confusing failure deep inside a
 * webhook rather than as "your key is wrong". This turns that debugging
 * session into a checklist.
 *
 * Run with: npm run preflight
 */

import { loadEnv } from "./load-env";

loadEnv();

type Status = "ok" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const results: CheckResult[] = [];

function record(r: CheckResult) {
  results.push(r);
  const icon = { ok: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" }[r.status];
  console.log(`  [${icon}] ${r.name} — ${r.detail}`);
  if (r.fix && r.status !== "ok") console.log(`         ↳ ${r.fix}`);
}

/** Never print a secret; showing shape is enough to spot a wrong paste. */
function mask(value: string | undefined): string {
  if (!value) return "unset";
  if (value.length <= 8) return `${value.length} chars`;
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

const REQUIRED_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_MCP_MERCHANT_TOKEN",
  "ANTHROPIC_API_KEY",
];

const EXPECTED_TABLES = [
  "revenue_events",
  "agent_decisions",
  "recovery_actions",
  "outcomes",
  "customer_consent",
  "audit_log",
  // Added after the initial schema — a stale database is missing exactly
  // this one, and without it every event 500s at assignment time rather
  // than failing here with a clear message.
  "experiment_assignments",
];

async function checkEnv() {
  console.log("\nEnvironment");
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);

  for (const v of REQUIRED_VARS) {
    record({
      name: v,
      status: process.env[v] ? "ok" : "fail",
      detail: mask(process.env[v]),
      fix: process.env[v] ? undefined : "Add it to .env.local — see docs/SETUP.md",
    });
  }

  return missing.length === 0;
}

async function checkSupabase() {
  console.log("\nSupabase");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    record({
      name: "connection",
      status: "skip",
      detail: "credentials not set",
      fix: "Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first",
    });
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  for (const table of EXPECTED_TABLES) {
    try {
      const { error } = await db.from(table).select("*", { head: true, count: "exact" });
      record({
        name: `table ${table}`,
        status: error ? "fail" : "ok",
        detail: error ? error.message : "reachable",
        fix: error ? "Run supabase/schema.sql in the Supabase SQL editor" : undefined,
      });
    } catch (err: any) {
      record({
        name: `table ${table}`,
        status: "fail",
        detail: err?.message ?? "unreachable",
        fix: "Check SUPABASE_URL is the project URL, not the dashboard URL",
      });
    }
  }
}

async function checkRazorpayRest() {
  console.log("\nRazorpay REST (validates key id / secret)");

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    record({ name: "auth", status: "skip", detail: "keys not set" });
    return;
  }

  if (!keyId.startsWith("rzp_test_")) {
    record({
      name: "test mode",
      status: "warn",
      detail: `key id is "${keyId.slice(0, 9)}…"`,
      fix: "This does not look like a test-mode key. Live keys move real money — switch the dashboard to Test Mode.",
    });
  }

  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      },
    });
    record({
      name: "auth",
      status: res.ok ? "ok" : "fail",
      detail: `HTTP ${res.status}`,
      fix: res.ok ? undefined : "Regenerate the test key pair in Razorpay → Settings → API Keys",
    });
  } catch (err: any) {
    record({ name: "auth", status: "fail", detail: err?.message ?? "unreachable" });
  }
}

async function checkMerchantToken() {
  console.log("\nRazorpay MCP");

  const token = process.env.RAZORPAY_MCP_MERCHANT_TOKEN;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!token) {
    record({ name: "merchant token", status: "skip", detail: "not set" });
    return;
  }

  // The most common misconfiguration is a token generated with a trailing
  // newline (`echo` without -n) or from the wrong key pair. Both are visible
  // locally, without a network round trip.
  if (keyId && keySecret) {
    let decoded = "";
    try {
      decoded = Buffer.from(token, "base64").toString("utf8");
    } catch {
      /* handled below */
    }
    const expected = `${keyId}:${keySecret}`;
    const matches = decoded.trim() === expected;
    record({
      name: "token matches key pair",
      status: matches ? "ok" : "fail",
      detail: matches ? "decodes to key_id:key_secret" : "does not match RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET",
      fix: matches
        ? undefined
        : `Regenerate without a trailing newline: printf '%s' "$RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET" | base64`,
    });
    if (decoded !== decoded.trim()) {
      record({
        name: "token whitespace",
        status: "warn",
        detail: "decoded value has leading/trailing whitespace",
        fix: "Use printf instead of echo when generating it",
      });
    }
  }

  try {
    const { listMcpTools } = await import("../lib/razorpay-mcp-client");
    const tools = await listMcpTools();
    record({
      name: "server connection",
      status: "ok",
      detail: `connected, ${tools.length} tools available`,
    });

    for (const needed of ["create_payment_link", "fetch_payment"]) {
      record({
        name: `tool ${needed}`,
        status: tools.includes(needed) ? "ok" : "fail",
        detail: tools.includes(needed) ? "available" : "not exposed by the server",
        fix: tools.includes(needed)
          ? undefined
          : `Server exposes: ${tools.join(", ") || "nothing"} — the executor calls this tool by name`,
      });
    }
  } catch (err: any) {
    record({
      name: "server connection",
      status: "fail",
      detail: err?.message ?? "connection failed",
      fix: "Check the merchant token is base64 of key_id:key_secret for a test-mode key pair",
    });
  }
}

async function checkAnthropic() {
  console.log("\nAnthropic");

  if (!process.env.ANTHROPIC_API_KEY) {
    record({ name: "api key", status: "skip", detail: "not set" });
    return;
  }

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Smallest call that still proves the key works AND this model is
    // reachable on this account. Costs a fraction of a cent.
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    record({
      name: "claude-sonnet-5",
      status: "ok",
      detail: `reachable (stop_reason=${res.stop_reason})`,
    });
  } catch (err: any) {
    const msg = err?.message ?? "request failed";
    record({
      name: "claude-sonnet-5",
      status: "fail",
      detail: msg,
      fix: /credit|balance/i.test(msg)
        ? "Add credits at console.anthropic.com — the API has no free tier"
        : "Check ANTHROPIC_API_KEY is a valid key from console.anthropic.com",
    });
  }
}

async function checkWhatsApp() {
  console.log("\nWhatsApp Cloud API");

  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneId || !token) {
    record({
      name: "credentials",
      status: "warn",
      detail: "not set",
      fix: "Optional for the pipeline to run, but WhatsApp actions will record as failed until set",
    });
  } else {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${phoneId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const body: any = await res.json();
      record({
        name: "phone number",
        status: res.ok ? "ok" : "fail",
        detail: res.ok
          ? `${body.display_phone_number ?? phoneId} (${body.verified_name ?? "unverified"})`
          : body?.error?.message ?? `HTTP ${res.status}`,
        fix: res.ok
          ? undefined
          : "Access tokens from the Meta app dashboard expire in ~24h — regenerate or use a permanent token",
      });
    } catch (err: any) {
      record({ name: "phone number", status: "fail", detail: err?.message ?? "unreachable" });
    }
  }

  // Send safety is a hard requirement before seeding, not a nicety: the
  // synthetic batch uses plausible real Indian mobile numbers.
  const dryRun = process.env.WHATSAPP_DRY_RUN === "true";
  const testRecipient = process.env.WHATSAPP_TEST_RECIPIENT;

  record({
    name: "send safety",
    status: dryRun || testRecipient ? "ok" : "warn",
    detail: dryRun
      ? "dry run enabled — messages are logged, not sent"
      : testRecipient
        ? `all sends redirected to ${testRecipient}`
        : "live sends to whatever number is on the event",
    fix:
      dryRun || testRecipient
        ? undefined
        : "Set WHATSAPP_DRY_RUN=true before seeding — the synthetic batch uses plausible REAL mobile numbers",
  });

  record({
    name: "template payment_retry_nudge",
    status: "skip",
    detail: "cannot be verified from here",
    fix: "Confirm it is APPROVED in Meta Business Manager → WhatsApp Manager → Message templates",
  });
}

async function main() {
  console.log("Revenue Recovery Agent — preflight\n" + "=".repeat(42));

  const envOk = await checkEnv();
  if (!envOk) {
    console.log("\nSome required variables are missing — the checks below will be partial.");
  }

  await checkSupabase();
  await checkRazorpayRest();
  await checkMerchantToken();
  await checkAnthropic();
  await checkWhatsApp();

  const failures = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");

  console.log("\n" + "=".repeat(42));
  console.log(
    `${results.filter((r) => r.status === "ok").length} passed, ` +
      `${failures.length} failed, ${warnings.length} warnings, ` +
      `${results.filter((r) => r.status === "skip").length} skipped`
  );

  if (failures.length) {
    console.log("\nBlocking issues:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }

  console.log("\nAll blocking checks passed. Safe to run: npm run seed:batch");
}

main().catch((err) => {
  console.error("\nPreflight itself failed:", err);
  process.exit(1);
});
