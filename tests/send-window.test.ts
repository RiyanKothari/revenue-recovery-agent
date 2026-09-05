import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENING_HOUR,
  inQuietHours,
  isSchedulingEnabled,
  istHour,
  resolveSendWindow,
} from "../lib/send-window";

/**
 * The scheduler, tested at hours nobody wants to be awake for.
 *
 * Everything here is a pure function of an instant, which is the only reason
 * these assertions can exist — a scheduler that reads the wall clock can only
 * be tested by waiting.
 *
 * All fixtures are written as UTC instants with the IST hour named in a
 * comment, because IST is UTC+5:30 and a half-hour offset is exactly the kind
 * of thing that looks right and is wrong.
 */

const on = { enabled: true };

test("IST is read as IST, not as the server's locale", () => {
  // 08:30 UTC is 14:00 IST.
  assert.equal(istHour("2026-09-05T08:30:00.000Z"), 14);
  // 19:00 UTC is 00:30 IST the NEXT day — the day roll is the part that breaks.
  assert.equal(istHour("2026-09-05T19:00:00.000Z"), 0);
});

test("an afternoon insufficient_funds failure waits for the evening", () => {
  // 08:30 UTC = 14:00 IST.
  const window = resolveSendWindow("insufficient_funds", "2026-09-05T08:30:00.000Z", on);

  assert.ok(window.scheduledFor, "it defers");
  assert.equal(istHour(window.scheduledFor!), EVENING_HOUR);
  assert.match(window.reason, /deferred_to_evening/);
});

test("an evening insufficient_funds failure is sent immediately", () => {
  // 12:45 UTC = 18:15 IST. Waiting 45 minutes buys nothing and costs the
  // customer's attention while they are still in the checkout they abandoned.
  const window = resolveSendWindow("insufficient_funds", "2026-09-05T12:45:00.000Z", on);
  assert.equal(window.scheduledFor, null);
  assert.equal(window.reason, "immediate");
});

test("a transient failure is never deferred to the evening", () => {
  // A gateway error is fixed by tapping the link again, not by payday.
  const window = resolveSendWindow("gateway_error", "2026-09-05T08:30:00.000Z", on);
  assert.equal(window.scheduledFor, null);
});

test("nothing is sent at 3am, whatever the root cause", () => {
  // 21:30 UTC = 03:00 IST.
  const at = "2026-09-05T21:30:00.000Z";
  assert.equal(inQuietHours(at), true);

  for (const cause of ["gateway_error", "bank_timeout", "insufficient_funds", "unknown"]) {
    const window = resolveSendWindow(cause, at, on);
    assert.ok(window.scheduledFor, `${cause} is held`);
    assert.equal(
      inQuietHours(window.scheduledFor!),
      false,
      `${cause} is rescheduled to a waking hour`
    );
  }

  // The transient causes resume the moment quiet hours end, because the
  // failure is already hours stale by then and immediacy is the whole value.
  assert.equal(istHour(resolveSendWindow("gateway_error", at, on).scheduledFor!), 8);

  // insufficient_funds does not: 08:00 is the wrong answer to "the card had
  // no balance", and the evening branch is reached first for exactly that
  // reason. A 3am failure waits for the evening, not for breakfast.
  assert.equal(istHour(resolveSendWindow("insufficient_funds", at, on).scheduledFor!), EVENING_HOUR);
});

test("a late-evening failure is held until the morning, not sent at 22:00", () => {
  // 16:45 UTC = 22:15 IST.
  const window = resolveSendWindow("card_declined", "2026-09-05T16:45:00.000Z", on);
  assert.ok(window.scheduledFor);
  assert.equal(istHour(window.scheduledFor!), 8);
  assert.match(window.reason, /quiet_hours/);
  // Held, never dropped — the money is still recoverable in the morning.
  assert.ok(new Date(window.scheduledFor!).getTime() > new Date("2026-09-05T16:45:00.000Z").getTime());
});

test("the quiet-hours boundaries are closed at the right ends", () => {
  // 15:29 UTC = 20:59 IST — the last minute that still sends.
  assert.equal(inQuietHours("2026-09-05T15:29:00.000Z"), false);
  // 15:30 UTC = 21:00 IST — the first minute that does not.
  assert.equal(inQuietHours("2026-09-05T15:30:00.000Z"), true);
  // 02:29 UTC = 07:59 IST — still quiet.
  assert.equal(inQuietHours("2026-09-05T02:29:00.000Z"), true);
  // 02:30 UTC = 08:00 IST — sending resumes.
  assert.equal(inQuietHours("2026-09-05T02:30:00.000Z"), false);
});

test("a deferral never lands in the past", () => {
  // Just after the evening hour, so the same-day 19:00 has already gone.
  // 13:35 UTC = 19:05 IST.
  const at = "2026-09-05T13:35:00.000Z";
  const window = resolveSendWindow("card_declined", at, on);
  if (window.scheduledFor) {
    assert.ok(new Date(window.scheduledFor).getTime() > new Date(at).getTime());
  }
});

test("the kill switch sends everything immediately", () => {
  // 21:30 UTC = 03:00 IST — quiet hours, and still immediate when disabled.
  const window = resolveSendWindow("insufficient_funds", "2026-09-05T21:30:00.000Z", {
    enabled: false,
  });
  assert.equal(window.scheduledFor, null);
  assert.equal(window.reason, "scheduling_disabled");
});

test("scheduling is on unless deliberately switched off", () => {
  // The opposite polarity to WHATSAPP_DRY_RUN, deliberately: that flag guards
  // sending at all, this one only picks a moment, and the unsafe reading here
  // is a typo silently disabling quiet hours.
  assert.equal(isSchedulingEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isSchedulingEnabled({ SCHEDULED_SENDS: "true" } as any), true);
  assert.equal(isSchedulingEnabled({ SCHEDULED_SENDS: "yes" } as any), true);
  assert.equal(isSchedulingEnabled({ SCHEDULED_SENDS: "false" } as any), false);
  assert.equal(isSchedulingEnabled({ SCHEDULED_SENDS: " FALSE " } as any), false);
});
