/**
 * Atomic seat acquisition / release for organizations.
 *
 * Uses conditional raw SQL UPDATEs that only succeed when the capacity
 * constraint is met. This eliminates the read-check-write race where
 * concurrent requests could both pass a pre-check and both increment.
 */

import { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

/**
 * Atomically acquire one learner seat. Returns true if acquired, false
 * if the org is at capacity. Must be called inside a transaction.
 *
 * The UPDATE's WHERE clause prevents execution when the org is full,
 * so two concurrent calls cannot both succeed.
 */
export async function acquireSeat(
  tx: TxClient,
  organizationProfileId: string,
): Promise<boolean> {
  const rows: number = await tx.$executeRaw`
    UPDATE "OrganizationProfile"
    SET "seatsUsed" = "seatsUsed" + 1, "updatedAt" = NOW()
    WHERE id = ${organizationProfileId}
      AND ("seatsTotal" IS NULL OR "seatsUsed" < "seatsTotal")
  `;
  return rows > 0;
}

/**
 * Release one learner seat (decrement seatsUsed, floor at 0).
 */
export async function releaseSeat(
  tx: TxClient,
  organizationProfileId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "OrganizationProfile"
    SET "seatsUsed" = GREATEST("seatsUsed" - 1, 0), "updatedAt" = NOW()
    WHERE id = ${organizationProfileId}
  `;
}
