/**
 * Generates a realistic batch of failed-payment records, shaped exactly
 * like a Razorpay payment.failed webhook payload, and inserts them through
 * the SAME webhook route the real pipeline uses (via a local HTTP call) —
 * not a separate code path. This is deliberate: it proves the batch
 * numbers came from the real pipeline, not a shortcut that only exists for
 * the demo.
 *
 * Run with: npm run seed:batch
 */

const FAILURE_REASONS = [
  { code: "BAD_REQUEST_ERROR", desc: "Payment failed due to insufficient funds in the account.", method: "card", weight: 0.28 },
  { code: "GATEWAY_ERROR", desc: "Payment gateway timeout, please try again.", method: "netbanking", weight: 0.18 },
  { code: "BAD_REQUEST_ERROR", desc: "Card declined by the issuing bank. Do not honour.", method: "card", weight: 0.22 },
  { code: "SERVER_ERROR", desc: "Payment processing error at gateway.", method: "upi", weight: 0.14 },
  { code: "GATEWAY_ERROR", desc: "Network connection error during authorization.", method: "card", weight: 0.1 },
  { code: "BAD_REQUEST_ERROR", desc: "Invalid CVV entered.", method: "card", weight: 0.05 },
  { code: "SERVER_ERROR", desc: "Suspected fraud, transaction blocked for review.", method: "card", weight: 0.03 }, // deliberately non-recoverable
];

/**
 * Deterministic pseudo-randomness, seeded per event.
 *
 * The customer pool was already derived by modulo "so a re-run produces the
 * same batch and the same measured numbers" — but the failure mix, the
 * amounts and the simulated conversions all ran on Math.random(), so that
 * claim was false and the numbers moved every run. On one re-run the
 * measured lift crossed zero and the dashboard reported the effect as not
 * established, on the strength of nothing but a different random draw.
 *
 * That matters beyond demo stability. A batch whose measured result changes
 * without any code changing cannot be used to check whether a code change
 * moved it, which is most of what the batch is for.
 *
 * mulberry32 — small, fast, and good enough for a synthetic fixture. Not for
 * anything that needs cryptographic randomness, and nothing here does.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash, so a string id can seed the generator above. */
export function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function weightedPick<T extends { weight: number }>(items: T[], roll: number): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = roll * total;
  for (const item of items) {
    if ((r -= item.weight) <= 0) return item;
  }
  return items[items.length - 1];
}

function amountPaiseFrom(rand: () => number): number {
  // ₹150 – ₹15,000, log-ish distribution so most failures are small tickets
  return Math.round((150 + rand() * rand() * 14850) * 100);
}

function fakePhone(i: number): string {
  return `9198765${String(43000 + i).padStart(5, "0")}`;
}

/**
 * A share of events reuse an earlier customer.
 *
 * The first version gave every event its own customer, which meant the
 * cooldown window and the retry ceiling could never fire — three of the four
 * guardrails were unreachable in the demo, and the conformance verifier had
 * nothing real to check for I1-I3. A batch that never trips a stopping rule
 * doesn't demonstrate stopping rules.
 *
 * Deterministic (modulo, not random) so a re-run produces the same batch and
 * the same measured numbers.
 */
const REPEAT_CUSTOMER_RATE = 0.25;

/** Roughly this share of the customer pool has opted out. */
export const DND_CUSTOMER_RATE = 0.05;

export function uniqueCustomerCount(size: number): number {
  return Math.max(1, Math.ceil(size * (1 - REPEAT_CUSTOMER_RATE)));
}

export function customerIndexFor(i: number, size: number): number {
  const pool = uniqueCustomerCount(size);
  return i < pool ? i : i % pool;
}

/** Every 20th customer is opted out — see DND_CUSTOMER_RATE. */
export function isDndCustomer(customerIndex: number): boolean {
  return customerIndex % Math.round(1 / DND_CUSTOMER_RATE) === 0;
}

/**
 * How far back the batch's failures are spread.
 *
 * The first version stamped every event with the moment it was POSTed, which
 * compressed a realistic week of payment failures into ninety seconds. That
 * is not a cosmetic problem: with every event arriving inside the same
 * minute, the cooldown window behaves identically for any value between two
 * minutes and thirty days, so the guardrail could not be exercised, the
 * Policy Lab's most interesting knob moved nothing, and "average time to
 * recovery" measured the speed of the seeding script.
 *
 * Real failures arrive spread across days, so the batch says so. Deterministic
 * (derived from the index, not random) to keep re-runs reproducible.
 */
const BATCH_WINDOW_DAYS = 7;

export function syntheticCreatedAt(i: number, size: number, now = Date.now()): number {
  const windowMs = BATCH_WINDOW_DAYS * 86_400_000;
  const pool = uniqueCustomerCount(size);

  /**
   * First-time failures spread evenly across the window, oldest first.
   */
  const firstFailureAt = (index: number) => {
    const offsetMs = pool <= 1 ? 0 : (windowMs * (pool - 1 - index)) / (pool - 1);
    return now - offsetMs;
  };

  if (i < pool) return Math.floor(firstFailureAt(i) / 1000);

  /**
   * A repeat failure follows its customer's FIRST failure by a few hours,
   * not by a week.
   *
   * Spreading every event evenly made repeat attempts land days apart, which
   * put all of them outside any sane cooldown window — so the cooldown
   * guardrail became unreachable a second time, in the opposite direction
   * from the original bug. It is also simply wrong: a customer whose payment
   * fails usually retries the same day, not the following week.
   *
   * The gap alternates either side of the 240-minute default so the batch
   * contains both events the cooldown blocks and events it lets through.
   * A batch where the rule always fires demonstrates it no better than one
   * where it never does.
   */
  const customerIndex = customerIndexFor(i, size);
  const insideCooldown = i % 2 === 0;
  const gapHours = insideCooldown ? 1.5 : 9;

  return Math.floor((firstFailureAt(customerIndex) + gapHours * 3_600_000) / 1000);
}

/**
 * One clock for the whole batch, captured once.
 *
 * This was the intermittent test failure that survived a dozen clean runs
 * before anyone caught it in the act. `syntheticCreatedAt` defaulted its own
 * `now` to `Date.now()`, and `generateBatch` called it once per event — so
 * the batch was stamped against as many clocks as it had events, and any run
 * that straddled a second boundary produced timestamps that disagreed with
 * each other by one second.
 *
 * The visible symptom was a determinism test comparing two generated batches
 * and failing roughly one run in three. The real defect was worse than the
 * symptom: a batch whose events are stamped from different instants is not
 * the "reproducible fixture" the docs claim, and the cooldown gaps computed
 * from those timestamps were off by a second in a way nothing would have
 * surfaced.
 *
 * Taking `now` as an argument also makes the whole generator a pure function
 * of `(size, now)`, which is what lets the determinism test assert
 * byte-identity honestly rather than hoping the two calls land inside the
 * same second.
 */
export function generateBatch(size = 55, now = Date.now()) {
  return Array.from({ length: size }, (_, i) => {
    // Seeded on the index, so event i is the same event on every run.
    const rand = seeded(hashSeed(`synthetic|${size}|${i}`));
    const reason = weightedPick(FAILURE_REASONS, rand());
    const amount = amountPaiseFrom(rand);
    const paymentId = `pay_synthetic_${1000 + i}`;
    const customerIndex = customerIndexFor(i, size);

    // eventId rides in the x-razorpay-event-id header, exactly as Razorpay
    // sends it — it is deliberately not part of the signed body.
    return {
      eventId: `evt_synthetic_${1000 + i}`,
      body: {
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: `order_synthetic_${1000 + i}`,
              amount,
              currency: "INR",
              method: reason.method,
              error_code: reason.code,
              error_description: reason.desc,
              // Customer and contact follow the pool index, not the event
              // index, so a repeat customer really is the same person.
              customer_id: `cust_synthetic_${customerIndex}`,
              contact: `+${fakePhone(customerIndex)}`,
              // Razorpay sends this on every payment entity. The pipeline
              // keys its time-based rules off it rather than off delivery
              // time — see lib/event-time.ts.
              created_at: syntheticCreatedAt(i, size, now),
            },
          },
        },
      },
    };
  });
}

/**
 * Writes opt-in/opt-out state for the synthetic customer pool, so the DND
 * guardrail has real rows to block on. Idempotent — upserts on the primary
 * key, so re-running the batch doesn't duplicate or drift.
 */
async function seedConsent(size: number) {
  const { getDb } = await import("../lib/db");

  const pool = uniqueCustomerCount(size);
  const rows = Array.from({ length: pool }, (_, idx) => ({
    customer_id: `cust_synthetic_${idx}`,
    dnd: isDndCustomer(idx),
    whatsapp_opt_in: !isDndCustomer(idx),
    email_opt_in: !isDndCustomer(idx),
  }));

  const optedOut = rows.filter((r) => r.dnd).length;

  try {
    await getDb().upsertConsent(rows);
  } catch (err: any) {
    throw new Error(
      `Could not seed customer_consent (${err?.message ?? err}). The DND guardrail would be untested — fix this before trusting the batch.`
    );
  }

  console.log(
    `Seeded consent for ${rows.length} customers (${optedOut} opted out of contact).`
  );
}

/**
 * Synthetic customers do not pay. Something has to.
 *
 * Without `order.paid` events the outcomes table stays empty, both arms show
 * zero conversions, and the measured-lift panel — the centrepiece — has
 * nothing to measure. So the batch drives the real attribution path with
 * simulated recoveries.
 *
 * These two numbers are ASSUMPTIONS, not findings. They are the effect this
 * batch pretends the agent has; the pipeline then measures it back out
 * through the same holdout arithmetic real traffic would use. That is the
 * honest claim available here — the measurement machinery is exercised end to
 * end, and on real traffic the same panel reports the real effect.
 *
 * Nothing downstream is told which arm an event is in: the recovery arrives
 * as an ordinary signed webhook and attribution works it out, exactly as in
 * production.
 */
const ASSUMED_TREATED_CONVERSION = 0.34;
const ASSUMED_CONTROL_CONVERSION = 0.19;

/**
 * When a simulated recovery lands: 20 minutes to 20 hours after the failure,
 * comfortably inside the 24h attribution window. Derived from the event id
 * rather than random so a re-run produces the same measured averages.
 */
export function simulatedRecoveryAt(stableId: string, failedAtIso: string): number {
  // Keyed on a value that survives a re-run — a database-generated row id
  // would change every time and reproduce nothing.
  let hash = 0;
  for (const ch of stableId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;

  const minutes = 20 + (hash % 1180); // 20 min .. ~20 h
  const millis = new Date(failedAtIso).getTime() + minutes * 60_000;
  return Math.floor(millis / 1000);
}

async function simulateOutcomes() {
  if (process.env.SIMULATE_OUTCOMES === "false") {
    console.log("\nSkipping simulated recoveries (SIMULATE_OUTCOMES=false).");
    return;
  }

  const { getDb } = await import("../lib/db");
  const crypto = await import("crypto");
  const db = getDb();

  const webhookUrl =
    process.env.WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/razorpay";
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;

  const [events, assignments] = await Promise.all([db.listEvents(), db.listAssignments()]);
  const armByEvent = new Map(assignments.map((a) => [a.revenue_event_id, a.arm]));

  // Only events that actually entered the experiment can convert. Inventing
  // recoveries for blocked or ineligible events would corrupt both the
  // numerator and the denominator of the lift.
  const eligible = events.filter((e) => armByEvent.has(e.id));

  let sent = 0;
  for (const event of eligible) {
    const arm = armByEvent.get(event.id);
    const rate =
      arm === "control" ? ASSUMED_CONTROL_CONVERSION : ASSUMED_TREATED_CONVERSION;
    const orderId = event.razorpay_order_id;
    if (!orderId) continue;

    /**
     * Seeded on the ORDER id, not the row id.
     *
     * `event.id` is a UUID the database generates on insert, so it is
     * different on every run — seeding on it would have looked deterministic
     * while reproducing nothing. The synthetic order id is derived from the
     * event's index in the batch and is therefore stable across runs, which
     * is the property this actually needs.
     */
    if (seeded(hashSeed(`outcome|${orderId}`))() >= rate) continue;

    const body = JSON.stringify({
      event: "order.paid",
      payload: {
        payment: {
          entity: {
            id: `pay_recovered_${event.id.slice(0, 8)}`,
            order_id: orderId,
            amount: event.amount_paise,
            currency: "INR",
            /**
             * The recovery sits on the failure's timeline, a realistic gap
             * later — not at whatever moment the seeding script happens to
             * run. Stamping it "now" put every recovery days after its
             * failure and outside the 24h attribution window, which silently
             * discarded most of them and drove measured lift negative.
             *
             * Deterministic in the event id so re-runs reproduce the same
             * durations, and spread across the window so "average time to
             * recovery" has a distribution rather than a constant.
             */
            created_at: simulatedRecoveryAt(orderId, event.received_at),
          },
        },
      },
    });

    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": signature,
          "x-razorpay-event-id": `evt_paid_${event.id.slice(0, 12)}`,
        },
        body,
      });
      sent += 1;
    } catch {
      // A dropped recovery is one fewer conversion; the batch continues.
    }
  }

  await db.close();
  console.log(
    `\nSimulated ${sent} recoveries across ${eligible.length} enrolled events ` +
      `(assumed ${Math.round(ASSUMED_TREATED_CONVERSION * 100)}% treated / ` +
      `${Math.round(ASSUMED_CONTROL_CONVERSION * 100)}% control — an assumption, not a finding).`
  );
}

async function main() {
  // Next loads .env.local for the app; a standalone tsx script does not.
  const { loadEnv } = await import("./load-env");
  loadEnv();

  const webhookUrl = process.env.WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/razorpay";
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET not set — needed to sign synthetic events. Add it to .env.local, then run: npm run preflight"
    );
  }

  const crypto = await import("crypto");

  /**
   * Batch size matters statistically, not just cosmetically. With a 10%
   * holdout, 55 events leaves ~5 controls — far too few to measure lift
   * against. 800 gives ~80 control events, which is enough for a confidence
   * interval that means something. The extra Claude calls cost well under a
   * dollar.
   */
  const size = Number(process.argv[2] ?? process.env.BATCH_SIZE ?? 800);
  if (!Number.isFinite(size) || size < 1) {
    throw new Error(`Invalid batch size: ${process.argv[2] ?? process.env.BATCH_SIZE}`);
  }

  const pacingMs = Number(process.env.BATCH_PACING_MS ?? 40);
  const batch = generateBatch(size);

  console.log(
    `Seeding ${batch.length} synthetic revenue-at-risk events (pacing ${pacingMs}ms)...`
  );

  // Consent is merchant state, not event state, so it has to exist before the
  // events arrive. Without it the DND guardrail never fires and invariant I1
  // verifies nothing — the batch would "pass" a consent check that was never
  // actually exercised.
  await seedConsent(size);

  const tally: Record<string, number> = {};
  let processed = 0;

  for (const evt of batch) {
    const body = JSON.stringify(evt.body);
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

    /**
     * One bad event must never end the run.
     *
     * This previously called res.json() directly. A single transient provider
     * 503 made the webhook return an empty-bodied 500, res.json() threw
     * "Unexpected end of JSON input", and a 200-event batch died at event 16 —
     * taking the measured numbers with it. Across hundreds of events some
     * failures are close to certain; the batch has to absorb and report them.
     */
    let status: string;
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": signature,
          "x-razorpay-event-id": evt.eventId,
        },
        body,
      });

      const raw = await res.text();
      let parsed: any = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null; // non-JSON body — recorded as an http_* outcome below
      }

      status = parsed?.status ?? parsed?.error ?? `http_${res.status}`;
    } catch (err: any) {
      // The request itself failed — server restarted, connection reset.
      status = `request_failed:${String(err?.message ?? err).slice(0, 40)}`;
    }

    tally[status] = (tally[status] ?? 0) + 1;

    // Progress rather than 800 lines of output.
    if (++processed % 50 === 0 || processed === batch.length) {
      console.log(`  ${processed}/${batch.length} ...`);
    }

    await new Promise((r) => setTimeout(r, pacingMs)); // gentle pacing, not a stress test
  }

  await simulateOutcomes();

  console.log("\nOutcome by pipeline status:");
  for (const [status, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${status}`);
  }

  /**
   * Anything that is not a recognised pipeline outcome is a failed event,
   * and failed events silently shrink the batch the measured numbers rest on.
   *
   * Listed explicitly rather than matched by prefix: the first version looked
   * for `http_*` and missed `pipeline_error`, which was 154 of 200 events on
   * the very next run — the exact case the warning exists for.
   */
  const PIPELINE_OUTCOMES = new Set([
    "processed",
    "holdout_control",
    "blocked_by_guardrail",
    "not_recoverable",
    "skipped_negative_ev",
    "duplicate_ignored",
    "outcome_recorded",
    "refund_or_dispute_recorded",
    "no_matching_event",
    "ignored",
  ]);

  const failed = Object.entries(tally)
    .filter(([s]) => !PIPELINE_OUTCOMES.has(s))
    .reduce((sum, n) => sum + n[1], 0);

  if (failed > 0) {
    console.log(
      `\n${failed}/${batch.length} events did not process. Re-run the batch to pick them up — ` +
        `the webhook resumes any event that never reached a decision, so nothing is duplicated.`
    );
  }

  console.log(
    "\nDone. `holdout_control` events were deliberately left untreated — " +
      "the dashboard's measured lift is computed against them."
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
