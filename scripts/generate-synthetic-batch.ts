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

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    if ((r -= item.weight) <= 0) return item;
  }
  return items[items.length - 1];
}

function randomAmountPaise(): number {
  // ₹150 – ₹15,000, log-ish distribution so most failures are small tickets
  return Math.round((150 + Math.random() * Math.random() * 14850) * 100);
}

function fakePhone(i: number): string {
  return `9198765${String(43000 + i).padStart(5, "0")}`;
}

export function generateBatch(size = 55) {
  return Array.from({ length: size }, (_, i) => {
    const reason = weightedPick(FAILURE_REASONS);
    const amount = randomAmountPaise();
    const paymentId = `pay_synthetic_${1000 + i}`;

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
              customer_id: `cust_synthetic_${i}`,
              contact: `+${fakePhone(i)}`,
            },
          },
        },
      },
    };
  });
}

async function main() {
  const webhookUrl = process.env.WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/razorpay";
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET not set — needed to sign synthetic events.");

  const crypto = await import("crypto");
  const batch = generateBatch(55);

  console.log(`Seeding ${batch.length} synthetic revenue-at-risk events...`);

  for (const evt of batch) {
    const body = JSON.stringify(evt.body);
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": evt.eventId,
      },
      body,
    });

    console.log(`${evt.eventId}: ${res.status} ${(await res.json()).status ?? ""}`);
    await new Promise((r) => setTimeout(r, 150)); // gentle pacing, not a stress test
  }

  console.log("Done. Check the dashboard batch summary for recovery numbers.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
