import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client: this runs server-side only (webhook handler, agent,
 * batch scripts). Never expose this key to the browser — the dashboard
 * should read through a route handler or a scoped anon key, not this client.
 *
 * The client is created on first use, not at import. Constructing it at
 * module scope threw before any caller could react, which meant importing
 * anything that touched the database — including the guardrail rules — hard
 * failed without a configured environment, and `next build` only worked when
 * fed placeholder credentials. Deferring it keeps imports safe and surfaces a
 * missing key at the point something actually needs the database.
 */

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set these in .env.local — see docs/SETUP.md."
    );
  }

  client = createClient(url, serviceKey, { auth: { persistSession: false } });
  return client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const real = getClient();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
