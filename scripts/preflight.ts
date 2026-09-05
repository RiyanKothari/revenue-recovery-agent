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

/**
 * Grouped by service so the checks can be run one at a time. Credentials
 * usually arrive service by service, and a run that fails on a key you
 * haven't created yet buries the result you actually wanted to see.
 *
 *   npm run preflight                        -- everything
 *   npm run preflight database razorpay      -- just those
 *   npm run preflight --skip model           -- everything else
 */
const TEMPLATE_NAME = "payment_retry_nudge";

const SERVICES = ["database", "razorpay", "mcp", "model", "whatsapp"] as const;
type Service = (typeof SERVICES)[number];

const SERVICE_VARS: Record<Service, string[]> = {
  database: ["DATABASE_URL"],
  razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
  mcp: ["RAZORPAY_MCP_MERCHANT_TOKEN"],
  // Which key is required depends on DECISION_PROVIDER, so it is checked
  // inside checkDecisionModel rather than declared here.
  model: [],
  whatsapp: [], // optional — the pipeline runs without it, actions just record as failed
};

function selectedServices(argv: string[]): Service[] {
  const args = argv.map((a) => a.toLowerCase());

  const skipIndex = args.indexOf("--skip");
  if (skipIndex !== -1) {
    const skipped = new Set(args.slice(skipIndex + 1));
    return SERVICES.filter((s) => !skipped.has(s));
  }

  const named = args.filter((a) => (SERVICES as readonly string[]).includes(a));
  return named.length ? (named as Service[]) : [...SERVICES];
}

async function checkEnv(services: Service[]) {
  console.log("\nEnvironment");

  const required = services.flatMap((s) => SERVICE_VARS[s]);

  if (required.length === 0) {
    record({ name: "variables", status: "skip", detail: "none required for this selection" });
    return true;
  }

  for (const v of required) {
    record({
      name: v,
      status: process.env[v] ? "ok" : "fail",
      detail: mask(process.env[v]),
      fix: process.env[v] ? undefined : "Add it to .env.local — see docs/SETUP.md",
    });
  }

  return required.every((v) => Boolean(process.env[v]));
}

async function checkDatabase() {
  console.log("\nDatabase");

  if (!process.env.DATABASE_URL) {
    record({
      name: "connection",
      status: "skip",
      detail: "DATABASE_URL not set",
      fix: "Set a postgres:// or mysql:// connection string — see docs/SETUP.md",
    });
    return;
  }

  const { getDb, resolveDriver } = await import("../lib/db");
  const driver = resolveDriver(process.env.DATABASE_URL, process.env.DATABASE_DRIVER);

  const source = process.env.DATABASE_DRIVER ? "DATABASE_DRIVER" : "URL scheme";
  record({
    name: "driver",
    status: "ok",
    detail: `${driver} (from ${source})`,
  });

  let db;
  try {
    db = getDb();
    await db.ping();
    record({ name: "connection", status: "ok", detail: "reachable" });
  } catch (err: any) {
    record({
      name: "connection",
      status: "fail",
      detail: err?.message ?? "could not connect",
      fix: "Check the connection string, and that your IP is allowed by the database's network rules",
    });
    return;
  }

  try {
    const missing = await db.missingTables();
    record({
      name: "schema",
      status: missing.length === 0 ? "ok" : "fail",
      detail:
        missing.length === 0
          ? "all expected tables present"
          : `missing: ${missing.join(", ")}`,
      fix:
        missing.length === 0
          ? undefined
          : `Run db/schema.${driver}.sql against this database`,
    });
  } catch (err: any) {
    record({ name: "schema", status: "fail", detail: err?.message ?? "could not inspect" });
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

/**
 * Checks the provider that will actually run, and only that one.
 *
 * This used to probe Anthropic unconditionally, which was wrong twice over:
 * it reported a blocking failure for a provider the pipeline was not
 * configured to use, and it never checked the one it was — so the single
 * dependency the demo depends on went unverified while an unused key
 * generated the only red line on the report.
 *
 * It also spent money, or tried to. Probing an API that DECISION_PROVIDER
 * has not selected bills an account the operator did not choose to bill, and
 * "the preflight did it" is a poor reason to find a charge on a card.
 */
async function checkDecisionModel() {
  const { resolveProviderName } = await import("../lib/decision-model");

  let provider: "anthropic" | "gemini";
  try {
    provider = resolveProviderName();
  } catch (err: any) {
    console.log("\nDecision model");
    record({
      name: "provider",
      status: "fail",
      detail: err?.message ?? "not configured",
      fix: "Set DECISION_PROVIDER=gemini or anthropic in .env.local, with the matching key",
    });
    return;
  }

  console.log(`\nDecision model (${provider})`);
  record({ name: "provider", status: "ok", detail: `DECISION_PROVIDER=${provider}` });

  if (provider === "anthropic") {
    await probeAnthropic();
    return;
  }

  await probeGemini();

  if (process.env.ANTHROPIC_API_KEY) {
    // Present but deliberately unused. Said out loud so nobody spends an
    // hour wondering why a configured key never appears in the audit trail.
    record({
      name: "ANTHROPIC_API_KEY",
      status: "skip",
      detail: "set but unused — DECISION_PROVIDER selects gemini",
    });
  }
}

async function probeAnthropic() {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

    // Smallest call that still proves the key works AND this model is
    // reachable on this account. Costs a fraction of a cent.
    const model = process.env.DECISION_MODEL ?? "claude-sonnet-5";
    const res = await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    record({ name: model, status: "ok", detail: `reachable (stop_reason=${res.stop_reason})` });
  } catch (err: any) {
    const msg = err?.message ?? "request failed";
    record({
      name: "anthropic",
      status: "fail",
      detail: msg,
      fix: /credit|balance/i.test(msg)
        ? "Add credits at console.anthropic.com — the API has no free tier"
        : /workspace/i.test(msg)
          ? "This is an identity-linked key: it needs a workspace id, or use a standard API key"
          : "Check ANTHROPIC_API_KEY is a valid key from console.anthropic.com",
    });
  }
}

/**
 * Gemini's free tier is quota-limited per model per day, and the pipeline
 * falls through a chain when one is exhausted. Listing models proves the key
 * authenticates without spending a generate request from the quota the batch
 * is going to need.
 */
async function probeGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    record({ name: "GEMINI_API_KEY", status: "fail", detail: "not set" });
    return;
  }

  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": key },
    });
    const body: any = await res.json();

    if (!res.ok) {
      record({
        name: "gemini",
        status: "fail",
        detail: body?.error?.message ?? `HTTP ${res.status}`,
        fix: "Check GEMINI_API_KEY at aistudio.google.com/apikey",
      });
      return;
    }

    const names: string[] = (body?.models ?? []).map((m: any) =>
      String(m.name ?? "").replace("models/", "")
    );
    const wanted = process.env.DECISION_MODEL ?? "gemini-3.6-flash";

    record({
      name: "api key",
      status: "ok",
      detail: `authenticates — ${names.length} models visible`,
    });

    record({
      name: wanted,
      status: names.includes(wanted) ? "ok" : "warn",
      detail: names.includes(wanted) ? "available" : "not listed for this key",
      fix: names.includes(wanted)
        ? undefined
        : "The fallback chain covers this, but the primary model will be skipped on every call",
    });
  } catch (err: any) {
    record({ name: "gemini", status: "fail", detail: err?.message ?? "unreachable" });
  }
}

/**
 * Meta reports an expired token as OAuthException code 190 with the real
 * cause buried in a prose message ("Session has expired on ..."), and it
 * arrives on EVERY Graph endpoint. Without naming it, the template check
 * blames WHATSAPP_BUSINESS_ACCOUNT_ID and the send path records 400 separate
 * delivery failures — both of which send you looking in the wrong place for
 * a credential that simply timed out overnight.
 *
 * The tokens on the Meta app dashboard's API Setup tab last ~24 hours, so
 * this is not an edge case; it is what happens to every demo the next day.
 */
export function readMetaError(body: any): { message: string; expiredToken: boolean } {
  const error = body?.error;
  const message = error?.message ?? "unknown Graph API error";
  const expiredToken =
    error?.code === 190 ||
    /session has expired|access token.*expired/i.test(String(message));
  return { message, expiredToken };
}

const TOKEN_FIX =
  "Token expired. Meta's API Setup tokens last ~24h — regenerate it there for a quick demo, or create a System User token (Business Settings -> System Users -> Generate token, no expiry) so it survives judging day.";

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
      const { message, expiredToken } = readMetaError(body);
      record({
        name: "phone number",
        status: res.ok ? "ok" : "fail",
        detail: res.ok
          ? `${body.display_phone_number ?? phoneId} (${body.verified_name ?? "unverified"})`
          : expiredToken
            ? "access token expired"
            : message,
        fix: res.ok
          ? undefined
          : expiredToken
            ? TOKEN_FIX
            : "Check WHATSAPP_PHONE_NUMBER_ID on the Meta app dashboard's API Setup tab",
      });
    } catch (err: any) {
      record({ name: "phone number", status: "fail", detail: err?.message ?? "unreachable" });
    }
  }

  // Send safety is a hard requirement before seeding, not a nicety: the
  // synthetic batch uses plausible real Indian mobile numbers.
  // Uses the same predicate the send path uses. A preflight with its own copy
  // of a safety check can report "dry run enabled" while the sender disagrees,
  // which is worse than not checking at all.
  const { isDryRun } = await import("../lib/whatsapp");
  const dryRun = isDryRun();
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
        : "Sending is enabled (WHATSAPP_DRY_RUN=false). Unset it or set WHATSAPP_TEST_RECIPIENT — the synthetic batch uses plausible REAL mobile numbers",
  });

  await checkWhatsAppTemplate(token);
}

/**
 * The template is the slowest dependency and the easiest to get subtly
 * wrong. Approval status is only half of it: lib/whatsapp.ts sends exactly
 * two body parameters, so a template approved with one or three variables
 * fails at send time with a Meta error that names a parameter count rather
 * than the template. Checking the shape here turns that into a clear message
 * before the demo instead of during it.
 */
async function checkWhatsAppTemplate(token: string | undefined) {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!token || !wabaId) {
    record({
      name: "template payment_retry_nudge",
      status: "skip",
      detail: "needs WHATSAPP_BUSINESS_ACCOUNT_ID to check",
      fix: "Set it from the Meta app dashboard, or confirm approval manually in WhatsApp Manager",
    });
    return;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${wabaId}/message_templates?name=${TEMPLATE_NAME}&limit=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body: any = await res.json();

    if (!res.ok) {
      const { message, expiredToken } = readMetaError(body);
      record({
        name: "template payment_retry_nudge",
        status: expiredToken ? "skip" : "fail",
        detail: expiredToken ? "cannot verify — access token expired" : message,
        fix: expiredToken
          ? TOKEN_FIX
          : "Check WHATSAPP_BUSINESS_ACCOUNT_ID is the WhatsApp Business Account id, not the app id",
      });
      return;
    }

    const template = (body?.data ?? []).find((t: any) => t.name === TEMPLATE_NAME);

    if (!template) {
      record({
        name: "template payment_retry_nudge",
        status: "fail",
        detail: "not found on this business account",
        fix: "Create it in WhatsApp Manager → Message templates. Approval takes hours — submit it now.",
      });
      return;
    }

    const approved = template.status === "APPROVED";
    record({
      name: "template status",
      status: approved ? "ok" : template.status === "REJECTED" ? "fail" : "warn",
      detail: `${template.status} (${template.category ?? "no category"}, ${template.language ?? "?"})`,
      fix: approved
        ? undefined
        : template.status === "REJECTED"
          ? "Rejected — a bare URL in a body variable is the usual cause; a URL button is the alternative"
          : "Still under review. Sends will fail until it is APPROVED.",
    });

    // Shape check: the code sends exactly two body parameters.
    const bodyComponent = (template.components ?? []).find(
      (c: any) => String(c.type).toUpperCase() === "BODY"
    );
    const placeholders = new Set(
      String(bodyComponent?.text ?? "").match(/\{\{\s*\d+\s*\}\}/g) ?? []
    );

    record({
      name: "template variables",
      status: placeholders.size === 2 ? "ok" : "fail",
      detail: `${placeholders.size} body variable(s); lib/whatsapp.ts sends 2 (amount, link)`,
      fix:
        placeholders.size === 2
          ? undefined
          : "Body must contain exactly {{1}} and {{2}}, or the send fails on parameter count",
    });
  } catch (err: any) {
    record({
      name: "template payment_retry_nudge",
      status: "fail",
      detail: err?.message ?? "lookup failed",
    });
  }
}

async function main() {
  const services = selectedServices(process.argv.slice(2));

  console.log("Revenue Recovery Agent — preflight\n" + "=".repeat(42));
  console.log(`Checking: ${services.join(", ")}`);

  const envOk = await checkEnv(services);
  if (!envOk) {
    console.log("\nSome required variables are missing — the checks below will be partial.");
  }

  if (services.includes("database")) await checkDatabase();
  if (services.includes("razorpay")) await checkRazorpayRest();
  if (services.includes("mcp")) await checkMerchantToken();
  if (services.includes("model")) await checkDecisionModel();
  if (services.includes("whatsapp")) await checkWhatsApp();

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
