/**
 * Cron Job: Expire Stale Credits
 * Zeros out remaining balance on credits past their expiry date.
 * Run daily via cron: npx tsx scripts/referrals/expire-credits.ts
 */

import { expireStaleCredits } from "@/lib/referrals/service";

async function main() {
  console.log("🔄 Starting credit expiry job...");

  try {
    const expiredCount = await expireStaleCredits();
    console.log(`✅ Expired ${expiredCount} stale credits.`);
  } catch (error) {
    console.error("❌ Failed to expire credits:", error);
    process.exit(1);
  }

  process.exit(0);
}

main();
