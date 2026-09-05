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
 * Deliberately NOT presented as protection against a determined attacker.
 * The counter lives in module memory, and serverless gives each concurrent
 * instance its own — so the real ceiling is the limit multiplied by however
 * many instances are warm. That makes this a guard against accidental
 * hammering and casual abuse, which is the actual risk profile of a demo
 * deployment, and nothing more. Saying so here rather than letting the next
 * reader assume otherwise: a limiter believed to be stronger than it is, is
 * worse than none.
 *
 * A real deployment puts this at the edge — Vercel's own rate limiting, or a
 * shared store like Redis — where the count is not per-process.
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
