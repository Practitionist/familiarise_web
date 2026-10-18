/**
 * A draining sweep stops starting rows this long after its request began, so a
 * row already in flight (a Stream call report) still lands inside the ticker's
 * 20 s abort.
 */
export const SWEEP_START_DEADLINE_MS = 12_000;

/** True once a sweep that began at `startedAt` must stop starting rows. */
export function startDeadline(startedAt: number = Date.now()): () => boolean {
  const until = startedAt + SWEEP_START_DEADLINE_MS;
  return () => Date.now() >= until;
}
