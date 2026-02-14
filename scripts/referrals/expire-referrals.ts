/**
 * Cron Job: Expire Stale Referrals
 * Expires unqualified referrals that are past the 30-day qualification window.
 * Run daily via cron: npx tsx scripts/referrals/expire-referrals.ts
 */

import { expireStaleReferrals } from "@/lib/referrals/service";

async function main() {
  console.log("🔄 Starting referral expiry job...");

  try {
    const expiredCount = await expireStaleReferrals();
    console.log(`✅ Expired ${expiredCount} stale referrals.`);
  } catch (error) {
    console.error("❌ Failed to expire referrals:", error);
    process.exit(1);
  }

  process.exit(0);
}

main();
