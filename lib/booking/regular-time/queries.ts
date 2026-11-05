/**
 * The Prisma include that tells the entitlement a plan has a live Regular
 * time: one superseded-free row is enough.
 */
export const LIVE_REGULAR_TIME_PROBE = {
  where: { validUntil: null },
  select: { id: true },
  take: 1,
} as const;

/** Whether a row read with `LIVE_REGULAR_TIME_PROBE` has a live Regular time. */
export function hasLiveRegularTime(row: {
  regularTimes?: readonly unknown[];
}): boolean {
  return (row.regularTimes?.length ?? 0) > 0;
}
