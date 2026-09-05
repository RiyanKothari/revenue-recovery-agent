import { NextResponse } from "next/server";
import { dispatchDueActions } from "@/lib/dispatcher";
import { apiError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * Drains the scheduled-send queue. Called on a schedule by Vercel Cron (see
 * `vercel.json`), and safe to call by hand.
 *
 * **This one is authenticated, unlike every other endpoint here.** The others
 * are read-only; this one creates payment links and puts messages on people's
 * phones. Vercel signs its cron invocations with `CRON_SECRET` as a bearer
 * token, and an unset secret refuses everything rather than defaulting to
 * open — the same rule as the two webhook verifiers, for the same reason. An
 * open dispatch endpoint would let anyone drain the queue early, which is a
 * way of sending someone a payment link at 3am that no guardrail above would
 * ever have chosen.
 */
function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error(
      "[cron/dispatch] CRON_SECRET is not set — refusing to dispatch. An unauthenticated dispatcher would let anyone send the queue early."
    );
    return false;
  }

  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await dispatchDueActions();
    return NextResponse.json(summary);
  } catch (err) {
    return apiError("dispatch_failed", 500, err);
  }
}
