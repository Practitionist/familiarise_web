/**
 * A draining sweep stops starting rows this long after its request began, so a
 * row already in flight (a Stream call report) still lands inside the ticker's
 * 24 s abort for these targets, with room for a ~5 s cold boot.
 */
// ≈3.3 s setup + ≈0.31 s/session ⇒ ≈40 sessions/run ⇒ ≈80/h at the 30-min cadence.
export const SWEEP_START_DEADLINE_MS = 16_000;

/** A start deadline: true once it has passed; `until` is when (ms epoch), for bounding a call by the time left. */
export type RunDeadline = (() => boolean) & { until?: number };

/** True once a sweep that began at `startedAt` must stop starting rows. */
export function startDeadline(startedAt: number = Date.now()): RunDeadline {
  const until = startedAt + SWEEP_START_DEADLINE_MS;
  return Object.assign(() => Date.now() >= until, { until });
}

/** True once `share` of the run's start budget is spent, leaving the rest for a later loop. */
export function startDeadlineShare(
  share: number,
  startedAt: number = Date.now(),
): RunDeadline {
  const until = startedAt + SWEEP_START_DEADLINE_MS * share;
  return Object.assign(() => Date.now() >= until, { until });
}

/** Preserve committed deletes even when the continuation probe fails. */
export async function deleteBoundedPage({
  outOfTime,
  pick,
  remove,
  remains,
  onError,
}: {
  outOfTime: () => boolean;
  pick: () => Promise<{ id: string }[]>;
  remove: (ids: string[]) => Promise<{ count: number }>;
  remains: () => Promise<{ id: string } | null>;
  onError: (error: unknown) => void;
}): Promise<{ deleted: number; hasMore: boolean }> {
  if (outOfTime()) return { deleted: 0, hasMore: true };
  let deleted = 0;
  try {
    const rows = await pick();
    if (rows.length > 0) {
      if (outOfTime()) return { deleted: 0, hasMore: true };
      deleted = (await remove(rows.map((row) => row.id))).count;
    }
    return { deleted, hasMore: outOfTime() || Boolean(await remains()) };
  } catch (error) {
    onError(error);
    return { deleted, hasMore: true };
  }
}
