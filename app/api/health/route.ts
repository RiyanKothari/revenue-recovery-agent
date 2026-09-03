import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness for a deployed instance.
 *
 * Deliberately narrow. A health check that reports "ok" because the process
 * is running says nothing useful — this one round-trips the database and
 * confirms the tables the pipeline writes to actually exist, because those
 * are the two ways a fresh deployment is broken: the connection string is
 * wrong, or the migration was never run. Both produce a service that answers
 * requests and fails every webhook.
 *
 * It reports the driver and the missing tables, and nothing else. No
 * connection string, no key fingerprints, no version of anything — this is
 * the one endpoint that is safe to call unauthenticated, which makes it the
 * one endpoint where a detail leak is guaranteed to be public.
 */
export async function GET() {
  const started = Date.now();

  try {
    const db = getDb();
    await db.ping();
    const missing = await db.missingTables();

    const healthy = missing.length === 0;

    return NextResponse.json(
      {
        status: healthy ? "ok" : "degraded",
        database: { driver: db.driver, reachable: true, missing_tables: missing },
        latency_ms: Date.now() - started,
        // Names the fix rather than leaving an operator to guess which of the
        // two failure modes they are looking at.
        hint: healthy ? undefined : "Run `npm run db:migrate` against this database",
      },
      // Degraded is still a 503: a deployment missing its tables is not
      // serving, and a load balancer should be told so rather than sending
      // it traffic that will fail one webhook at a time.
      { status: healthy ? 200 : 503 }
    );
  } catch (err) {
    console.error("[api] health check failed:", (err as any)?.message ?? err);
    return NextResponse.json(
      { status: "unhealthy", database: { reachable: false }, latency_ms: Date.now() - started },
      { status: 503 }
    );
  }
}
