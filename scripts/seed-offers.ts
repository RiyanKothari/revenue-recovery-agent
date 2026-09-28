/**
 * Seeds the two offer configurations the Dark Pattern Sentinel is
 * demonstrated against.
 *
 *   npm run seed:offers
 *
 * They differ in exactly the way that matters and in no other way. Same
 * coupon, same 20% discount, same merchant. One is genuinely customer
 * specific and genuinely expires; the other is available to everyone and has
 * no expiry at all.
 *
 * Screen one message against both and it passes the first and is held by the
 * second, without a word of the copy changing. That is the Sentinel's whole
 * argument, and it is why a detector that scores copy for manipulative tone
 * cannot do this job: it cannot see either row.
 */

import { loadEnv } from "./load-env";
import { getDb } from "../lib/db";
import { resolveIdentity } from "../lib/ledger-writer";

loadEnv();

async function main() {
  const db = getDb();
  const { merchantId } = resolveIdentity();

  const now = Date.now();
  const hours = (n: number) => new Date(now + n * 60 * 60 * 1000).toISOString();

  const shared = {
    merchant_id: merchantId,
    coupon_code: "CART20",
    discount_kind: "percent" as const,
    discount_value: 20,
    units_remaining: null,
    previous_price_paise: null,
    recent_purchase_count: null,
  };

  await db.upsertMerchantOffer({
    ...shared,
    offer_id: "CART20_HONEST",
    valid_from: hours(-24 * 7),
    // A real deadline. "Expires in 24 hours" is information here.
    valid_until: hours(24),
    scope: "personalised",
  });

  await db.upsertMerchantOffer({
    ...shared,
    offer_id: "CART20_STANDING",
    valid_from: hours(-24 * 90),
    /**
     * The interesting null. Not unknown, not missing — the merchant
     * configured no expiry, which is exactly what turns "expires in 24 hours"
     * from information into a fabrication.
     */
    valid_until: null,
    scope: "universal",
  });

  const offers = await db.listMerchantOffers(merchantId);
  console.log(`Seeded ${offers.length} offer(s) for "${merchantId}":`);
  for (const offer of offers) {
    console.log(
      `  ${offer.offer_id.padEnd(18)} scope=${offer.scope} expiry=${offer.valid_until ?? "NONE"}`
    );
  }
  console.log("\nScreen a message against each and compare:");
  console.log('  curl -s localhost:3000/api/screen -H "content-type: application/json" \\');
  console.log(`    -d '{"message":"20% off, just for you — expires in 24 hours","offerId":"CART20_HONEST"}'`);

  await db.close();
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
