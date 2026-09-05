import type { RecoveryDb } from "./db";

/**
 * Rate limiting for the two endpoints that do real work on demand.
 *
 * `/api/replay` reads every event, decision, action and outcome in the batch
 * and re-runs the pipeline's gates over all of them; `/api/redteam` runs a
 * suite of checks. Both are public, unauthenticated and idempotent — so the
 * exposure is not data, it is that anyone can ask a deployed instance to do a
 * lot of work repeatedly, for free, at the database's expense.
 *
 * There are two counters here and the distinction is the whole point.
 *
 * **The in-memory window** (`rateLimit`) is a fixed window in module scope.
 * It is genuinely effective wherever the process is long-lived — local
 * development, a container, a single Node server — and worth almost nothing
 * on Vercel, which was measured rather than assumed: thirty-four consecutive
 * requests against a limit of thirty all returned 200 in production, because
 * each concurrent lambda gets its own module scope and therefore its own
 * counter, and the platform had spread the burst across enough instances that
 * no single counter ever reached its limit.
 *
 * **The shared window** (`enforceRateLimit`) fixes that by putting the
 * counter somewhere every instance can see: one atomic upsert against the
 * database, which is already provisioned and already on the request path.
 * Redis would serve equally well and would be the choice at real traffic;
 * a second service is not worth running for this when the endpoints being
 * protected are expensive precisely because they query *this* database. One
 * cheap upsert to refuse a full-table scan pays for itself.
 *
 * The in-memory window is kept in front of it as a first stage, so a client
 * that lands repeatedly on one warm instance is refused without a round trip
 * at all.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Seconds until the window resets — sent as Retry-After on a refusal. */
  retryAfterSeconds: number;
  /**
   * Which counter answered. Reported so an operator can tell a limit that is
   * actually holding across the fleet from one that only held locally.
   */
  scope?: "process" | "shared";
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitResult {
  const existing = windows.get(key);

  if (!existing || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds };
}

/**
 * Keeps the map from growing without bound.
 *
 * A limiter that leaks memory to prevent resource abuse has become the thing
 * it was guarding against. Called on each check, which is cheap because the
 * map only ever holds one entry per key and this project has two.
 */
export function pruneRateLimits(now = Date.now()): void {
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
}

/** Test seam. Never called by the routes. */
export function resetRateLimits(): void {
  windows.clear();
}

/** Just the counter, so a test can supply one without a database. */
export type RateLimitStore = Pick<RecoveryDb, "hitRateLimit">;

/**
 * The check the routes actually call: process window first, shared counter
 * second.
 *
 * **This one fails open.** That is the opposite of every other guard in this
 * codebase and it is deliberate. The fail-closed rule exists because refusing
 * to act is always safer than acting wrongly — a guardrail that cannot be
 * evaluated must not let a message reach a customer. Nothing comparable is at
 * stake here: these endpoints are read-only, they contact nobody, and the
 * harm being prevented is a large query. Failing closed would mean a blip in
 * the counter table takes the dashboard's Policy Lab and Red Team panels
 * offline — trading a certain outage for a hypothetical load spike. The
 * failure is logged rather than swallowed, and the process window still
 * applies, so the endpoint is never left with no limit at all.
 */
export async function enforceRateLimit(
  bucket: string,
  limit: number,
  windowMs: number,
  store: RateLimitStore | null,
  now = Date.now()
): Promise<RateLimitResult> {
  pruneRateLimits(now);

  const local = rateLimit(bucket, limit, windowMs, now);
  if (!local.allowed) return { ...local, scope: "process" };

  if (!store) return local;

  try {
    const { count, resetAt } = await store.hitRateLimit(
      bucket,
      windowMs,
      new Date(now).toISOString()
    );

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((new Date(resetAt).getTime() - now) / 1000)
    );

    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds, scope: "shared" };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: 0,
      scope: "shared",
    };
  } catch (err: any) {
    console.error(
      `[rate-limit] shared counter unavailable for "${bucket}", falling back to the per-process window:`,
      err?.message ?? err
    );
    return { ...local, scope: "process" };
  }
}
