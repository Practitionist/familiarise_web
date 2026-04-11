/**
 * Orphaned Org Credit Purchase Cleanup — Core Logic
 *
 * An OrgCreditPurchase row is created the moment a Razorpay order is initiated.
 * If the user abandons checkout (browser close, network drop, gateway timeout),
 * the `payment.captured` webhook never fires and the row sits with
 * `paymentId: null` indefinitely. The org's credit pool balance is never
 * updated, but the pending row can mislead the dashboard's purchase history.
 *
 * This script marks such rows as cancelled by setting `expiresAt` to the Unix
 * epoch (a sentinel value) so the dashboard can filter them out. We use a soft
 * approach rather than hard deletion to preserve the audit trail.
 *
 * Threshold: purchases older than 24 hours with no linked payment.
 *
 * This module exports the core cleanup function.
 * It is imported by:
 *   - jobs/enterprise/cleanup-orphaned-org-credit-purchases.ts (GitHub Actions)
 *   - app/api/cleanup/orphaned-org-credit-purchases/route.ts   (API endpoint)
 *
 * Schedule: Daily at 02:00 UTC
 */

import prisma from "../../lib/prisma";

export interface OrphanedPurchaseCleanupResult {
  success: boolean;
  cancelledCount: number;
  ids: string[];
  errors: string[];
  timestamp: string;
}

const ORPHAN_THRESHOLD_HOURS = 24;

// Epoch sentinel — dashboard filters purchases where expiresAt = epoch as CANCELLED.
const CANCELLED_SENTINEL = new Date(0);

export async function cleanupOrphanedOrgCreditPurchases(): Promise<OrphanedPurchaseCleanupResult> {
  const errors: string[] = [];
  const timestamp = new Date().toISOString();
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_HOURS * 60 * 60 * 1000);

  console.log("🧹 Starting orphaned org credit purchase cleanup...");
  console.log(`   Threshold: ${ORPHAN_THRESHOLD_HOURS}h (cutoff: ${cutoff.toISOString()})`);

  try {
    const orphans = await prisma.orgCreditPurchase.findMany({
      where: {
        paymentId: null,
        purchasedAt: { lt: cutoff },
        // Skip already-cancelled rows (expiresAt = epoch sentinel)
        NOT: { expiresAt: CANCELLED_SENTINEL },
      },
      select: { id: true, organizationProfileId: true, creditsPurchased: true, purchasedAt: true },
    });

    if (orphans.length === 0) {
      console.log("   ✅ No orphaned purchases found.");
      return { success: true, cancelledCount: 0, ids: [], errors: [], timestamp };
    }

    console.log(`   Found ${orphans.length} orphaned purchase(s) to cancel.`);

    const ids = orphans.map((o) => o.id);

    await prisma.orgCreditPurchase.updateMany({
      where: { id: { in: ids } },
      data: { expiresAt: CANCELLED_SENTINEL },
    });

    console.log(`   🗑️  Cancelled ${ids.length} orphaned purchase(s): ${ids.join(", ")}`);

    return { success: true, cancelledCount: ids.length, ids, errors: [], timestamp };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("   ❌ Cleanup failed:", message);
    errors.push(message);
    return { success: false, cancelledCount: 0, ids: [], errors, timestamp };
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
