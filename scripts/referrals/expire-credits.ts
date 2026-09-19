/**
 * Expire Stale Credits - Core Logic
 *
 * Zeros `remainingAmount` on referral credits past their `expiresAt`. Expired
 * credits are already unusable (filtered at read), so this is bookkeeping that
 * keeps balances honest; it moves no money.
 *
 * This module exports the core function. It is imported by:
 * - jobs/referrals/expire-credits.ts (GitHub Actions)
 *
 * Schedule: Daily
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { expireStaleCredits } from "@/lib/referrals/service";

export interface ExpireCreditsResult {
  success: boolean;
  expiredCount: number;
  errors: string[];
  timestamp: string;
}

// #1757 — this script had no workflow and no ticker target, so it never ran.
// Locked like its siblings so a schedule and a manual dispatch cannot overlap;
// fail-open: the write is idempotent (an already-zeroed row matches nothing).
export async function expireCredits(): Promise<ExpireCreditsResult> {
  return withCronLock("expire-credits", { failMode: "open" }, () =>
    expireCreditsUnlocked(),
  );
}

async function expireCreditsUnlocked(): Promise<ExpireCreditsResult> {
  const errors: string[] = [];
  let expiredCount = 0;

  try {
    expiredCount = await expireStaleCredits();
    console.log(`✅ Expired ${expiredCount} stale credit(s).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error(`❌ Failed to expire credits: ${message}`);
  }

  return {
    success: errors.length === 0,
    expiredCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
