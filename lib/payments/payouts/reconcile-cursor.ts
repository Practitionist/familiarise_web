/**
 * Rotation cursor for the bounded payout reconcilers.
 *
 * Each reconciler takes its cohort least-recently-polled first and stamps a row
 * only once its poll has ended, so a run cut short by a timeout leaves every row
 * it never reached at the head of the next run. The stamp is raw SQL because
 * Prisma's `@updatedAt` would move `updatedAt`, the reconcilers' aging clock.
 */

import prisma from "@/lib/prisma";

/** Per-cohort cap for a caller that passes no `limit` (admin run, post-recovery). */
export const DEFAULT_RECONCILE_LIMIT = 100;

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

/**
 * Polls `rows` in order, starting none once `pastDeadline()`, and stamps each row
 * as its poll ends, thrown or not. A failed poll or stamp goes to `onError` and
 * never stops the rows behind it. Returns how many rows were started.
 */
export async function pollInRotation<T extends { id: string }>(
  rows: readonly T[],
  stamp: (ids: string[]) => Promise<void>,
  pastDeadline: () => boolean,
  onError: (row: T, err: unknown) => void,
  poll: (row: T) => Promise<void>,
): Promise<number> {
  let started = 0;
  for (const row of rows) {
    if (pastDeadline()) break;
    started++;
    try {
      await poll(row);
    } catch (err) {
      onError(row, err);
    }
    try {
      await stamp([row.id]);
    } catch (err) {
      onError(row, err);
    }
  }
  return started;
}
