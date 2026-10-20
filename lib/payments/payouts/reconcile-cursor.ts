/**
 * Rotation cursor for the bounded payout reconcilers.
 *
 * Each reconciler takes its cohort least-recently-polled first and stamps every
 * row it took, so no row is revisited before every row was polled, and any
 * ceil(cohort / limit) consecutive runs cover the whole cohort. The stamp is raw
 * SQL because Prisma's `@updatedAt` would move `updatedAt`, the reconcilers' aging clock.
 */

import prisma from "@/lib/prisma";

/** Orders a cohort by its rotation cursor: never polled first, then oldest poll. */
export const LEAST_RECENTLY_RECONCILED = {
  lastReconciledAt: { sort: "asc", nulls: "first" },
} as const;

export async function stampConsultantPayoutsReconciled(
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await prisma.$executeRaw`UPDATE "ConsultantPayout" SET "lastReconciledAt" = now() WHERE "id" = ANY(${ids}::text[])`;
}

export async function stampOrgPayoutsReconciled(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.$executeRaw`UPDATE "OrganizationPayout" SET "lastReconciledAt" = now() WHERE "id" = ANY(${ids}::text[])`;
}
