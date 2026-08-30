import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set these in .env.local — see docs/SETUP.md."
  );
}

// Service-role client: this runs server-side only (webhook handler, agent,
// batch scripts). Never expose this key to the browser — the dashboard
// should read through a route handler or a scoped anon key, not this client.
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
