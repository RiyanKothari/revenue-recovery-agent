import type { RootCause } from "./classifier";

/**
 * *When* to send, as a decision separate from *what* to send.
 *
 * The agent picks a channel. For most root causes the right moment is
 * immediately — a bank timeout or a gateway error is a transient fault and the
 * retry works as soon as the customer taps it. For one cause it is not:
 * `insufficient_funds` means the card had no balance at that moment, and
 * sending a link into an empty account converts at whatever rate an empty
 * account converts at. The useful variable there is the hour, not the channel.
 *
 * Two rules, and both are deliberately dull:
 *
 * **Deferral is narrow.** Only `insufficient_funds` defers, only to the same
 * evening, and only when the failure happened early enough that the evening is
 * a meaningful wait. A failure at 6pm is not held until 7pm for an hour of
 * theoretical benefit — the customer is still in the checkout they just
 * abandoned, and immediacy is worth more than the model.
 *
 * **Quiet hours apply to everything.** Nothing is sent between 21:00 and 08:00
 * IST. A payment-retry nudge at 3am is a complaint, not a recovery, and no
 * conversion-rate argument survives contact with someone woken by it. A send
 * that would land in quiet hours is moved to 08:00, never dropped.
 *
 * The whole module is pure and takes its clock as an argument, because a
 * scheduler you cannot test at 2am on a Sunday is a scheduler you cannot test.
 * Timezone handling is fixed to IST rather than the server's locale: Razorpay
 * merchants and their customers are in India, and inferring the customer's
 * timezone from a phone number would be a guess dressed as personalisation.
 */

/** IST is UTC+5:30 and observes no daylight saving, which makes this exact. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

export const QUIET_HOURS_START = 21; // 21:00 IST — nothing sent after this
export const QUIET_HOURS_END = 8; //    08:00 IST — sending resumes

/** When a payday-shaped failure is retried, if it defers at all. */
export const EVENING_HOUR = 19;

/**
 * The latest hour at which deferring to the evening still buys anything. A
 * failure at 17:30 waits ninety minutes; one at 18:30 does not wait at all.
 */
export const LATEST_DEFERRABLE_HOUR = 17;

export interface SendWindow {
  /** ISO instant, or null for "now". */
  scheduledFor: string | null;
  /** Recorded on the action and shown in the trace. */
  reason: string;
}

/** Wall-clock hour in IST for an instant. */
export function istHour(iso: string): number {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours();
}

/** The instant at `hour`:00 IST on the same IST day as `iso`, or the next one. */
function istHourOnOrAfter(iso: string, hour: number): string {
  const at = new Date(iso).getTime();
  const shifted = new Date(at + IST_OFFSET_MINUTES * 60_000);

  shifted.setUTCHours(hour, 0, 0, 0);
  let target = shifted.getTime() - IST_OFFSET_MINUTES * 60_000;

  // Rolled to tomorrow when that hour has already passed today.
  if (target <= at) target += 24 * 60 * 60_000;

  return new Date(target).toISOString();
}

/**
 * Whether sending at this instant would land in quiet hours.
 *
 * Exported because the dispatcher checks it again at dispatch time. A send
 * scheduled for 20:55 that the queue reaches at 21:05 must not go out on the
 * strength of having been scheduled while it was still allowed.
 */
export function inQuietHours(iso: string): boolean {
  const hour = istHour(iso);
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

export interface SendWindowOptions {
  /**
   * Kill switch. Set `SCHEDULED_SENDS=false` and every send goes out
   * immediately, which is exactly the behaviour that predates this module —
   * useful when demonstrating the pipeline end to end without waiting for an
   * evening to arrive.
   */
  enabled?: boolean;
}

export function resolveSendWindow(
  rootCause: RootCause | string,
  eventTimeIso: string,
  options: SendWindowOptions = {}
): SendWindow {
  const enabled = options.enabled ?? isSchedulingEnabled();

  if (!enabled) {
    return { scheduledFor: null, reason: "scheduling_disabled" };
  }

  const hour = istHour(eventTimeIso);

  if (rootCause === "insufficient_funds" && hour < LATEST_DEFERRABLE_HOUR) {
    const evening = istHourOnOrAfter(eventTimeIso, EVENING_HOUR);
    return {
      scheduledFor: evening,
      reason: `deferred_to_evening: the card had no balance at ${String(hour).padStart(2, "0")}:00 IST, and a link sent into an empty account converts at an empty account's rate. Held until ${EVENING_HOUR}:00.`,
    };
  }

  if (inQuietHours(eventTimeIso)) {
    return {
      scheduledFor: istHourOnOrAfter(eventTimeIso, QUIET_HOURS_END),
      reason: `deferred_quiet_hours: ${String(hour).padStart(2, "0")}:00 IST is inside the ${QUIET_HOURS_START}:00–0${QUIET_HOURS_END}:00 window. Held until 0${QUIET_HOURS_END}:00.`,
    };
  }

  return { scheduledFor: null, reason: "immediate" };
}

/**
 * Defaults to on, and reads the same way as every other flag in this project:
 * anything other than an explicit "false" leaves the feature enabled.
 *
 * The opposite polarity to `WHATSAPP_DRY_RUN`, and deliberately so. That flag
 * guards *sending at all*, so its unset state must be the safe one. This one
 * only chooses a moment — the unsafe reading would be a typo silently
 * disabling quiet hours and putting a nudge on someone's phone at 3am.
 */
export function isSchedulingEnabled(env = process.env): boolean {
  return env.SCHEDULED_SENDS?.trim().toLowerCase() !== "false";
}
