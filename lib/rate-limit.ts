/**
 * A small fixed-window rate limiter for the two endpoints that do real work
 * on demand.
 *
 * `/api/replay` reads every event, decision, action and outcome in the batch
 * and re-runs the pipeline's gates over all of them; `/api/redteam` runs a
 * suite of checks. Both are public, unauthenticated, and idempotent — so the
 * exposure is not data, it is that anyone can ask a deployed instance to do
 * a lot of work repeatedly, for free, at the database's expense.
 *
 * ON VERCEL THIS DOES ALMOST NOTHING, and that is measured rather than
 * assumed. The counter lives in module memory and each concurrent lambda
 * instance gets its own, so thirty-four consecutive requests against a limit
 * of thirty all returned 200 in production — the platform had spread them
 * across enough instances that no single counter ever reached its limit.
 *
 * It is kept because it is genuinely effective wherever the process is
 * long-lived — local development, a container, a single Node server — and
 * because a sequential burst from one client does often land on one warm
 * instance. It is not kept under any illusion that it hardens the deployed
 * endpoint.
 *
 * The real fix is a shared counter: Vercel's own edge rate limiting, Redis,
 * or a table in the database this is protecting — one cheap upsert to refuse
 * an expensive scan. That is the change to make before this is exposed to
 * traffic that is not a demo.
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
