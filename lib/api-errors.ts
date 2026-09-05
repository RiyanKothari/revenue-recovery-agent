import { NextResponse } from "next/server";

/**
 * What a failing route tells the client, and what it keeps to itself.
 *
 * Every route used to answer with `detail: err.message`, which meant a bad
 * URL returned `invalid input syntax for type uuid` — naming the engine, the
 * column type, and the shape of the query to anyone who asked. That is free
 * reconnaissance on a deployed service, and it arrives through the one
 * endpoint that takes user-controlled input.
 *
 * So the split is: the client gets a stable machine-readable code it can act
 * on, and the operator gets the real cause in the server log. Nothing is
 * swallowed — a failure that vanishes is worse than one that says too much.
 */
export function apiError(
  code: string,
  status: number,
  cause?: unknown
): NextResponse {
  if (cause !== undefined) {
    console.error(`[api] ${code}:`, (cause as any)?.message ?? cause);
  }
  return NextResponse.json({ error: code }, { status });
}

/**
 * A refusal that tells the caller when to come back.
 *
 * A bare 429 with no Retry-After leaves a well-behaved client guessing, and
 * guessing clients retry immediately — which is the traffic the limit exists
 * to shed.
 */
export function rateLimited(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited", retry_after_seconds: retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

/**
 * Whether a string could be an event id at all.
 *
 * Event ids are UUIDs, and the database says so — handing it anything else
 * raises a cast error, which the route then reported as a 500. A request for
 * an id that cannot exist is a client mistake, not a server fault, and
 * checking the shape here means the difference is visible without a round
 * trip. Deliberately a shape check rather than a strict RFC 4122 version
 * check: rejecting a legitimately-stored id because its version nibble is
 * unfashionable would be worse than accepting one that simply is not found.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeEventId(value: string): boolean {
  return UUID_SHAPE.test(value);
}
