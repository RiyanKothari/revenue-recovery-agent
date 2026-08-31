import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Wraps Razorpay's OFFICIAL hosted MCP server (mcp.razorpay.com) — this is
 * not a hand-rolled REST client. Using Razorpay's own agent-tooling layer
 * for the action executor is the whole point: this project's agent calls
 * the exact same tool surface Razorpay built for AI agents to take payment
 * actions, rather than us reimplementing it.
 *
 * Docs: https://razorpay.com/docs/mcp-server/
 * Auth: base64(key_id:key_secret) as a Basic auth header — generate with:
 *   echo <RAZORPAY_KEY_ID>:<RAZORPAY_KEY_SECRET> | base64
 */

let clientPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;

  const merchantToken = process.env.RAZORPAY_MCP_MERCHANT_TOKEN;
  if (!merchantToken) {
    throw new Error(
      "Missing RAZORPAY_MCP_MERCHANT_TOKEN. See docs/SETUP.md for how to generate it from your test-mode key/secret."
    );
  }

  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.razorpay.com/mcp"),
      {
        requestInit: {
          headers: { Authorization: `Basic ${merchantToken}` },
        },
      }
    );

    const client = new Client(
      { name: "revenue-recovery-agent", version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    return client;
  })();

  return clientPromise;
}

/**
 * Creates a fresh Razorpay Payment Link for a retry attempt, and sends it
 * to the customer directly via the MCP server's send-link tool — this
 * single call replaces what would otherwise be a Payment Links API call
 * plus a separate notification step.
 */
export async function createAndSendRetryLink(params: {
  amountPaise: number;
  currency: string;
  customerContact: string;
  channel: "sms" | "email";
  description: string;
}): Promise<{ paymentLinkId: string; shortUrl: string; status: string }> {
  const client = await getClient();

  const createResult = await client.callTool({
    name: "create_payment_link",
    arguments: {
      amount: params.amountPaise,
      currency: params.currency,
      description: params.description,
      customer: { contact: params.customerContact },
      notify: { sms: params.channel === "sms", email: params.channel === "email" },
    },
  });

  const parsed = parseToolResult(createResult);
  return { paymentLinkId: parsed.id, shortUrl: parsed.short_url, status: parsed.status };
}

/**
 * Connects and lists the tools the MCP server exposes. Used by the preflight
 * check to prove the merchant token actually authenticates AND that the two
 * tools this project depends on are present, before a real recovery attempt
 * discovers otherwise mid-demo.
 */
export async function listMcpTools(): Promise<string[]> {
  const client = await getClient();
  const result = await client.listTools();
  return result.tools.map((t) => t.name);
}

/** Fetches current payment status — used by the outcome tracker. */
export async function fetchPaymentStatus(paymentId: string): Promise<string> {
  const client = await getClient();
  const result = await client.callTool({
    name: "fetch_payment",
    arguments: { payment_id: paymentId },
  });
  return parseToolResult(result).status;
}

function parseToolResult(result: unknown): any {
  // MCP tool results come back as content blocks; the Razorpay server
  // returns JSON text in the first block.
  const content = (result as any)?.content?.[0]?.text;
  if (!content) throw new Error("Unexpected empty MCP tool result");
  return JSON.parse(content);
}
