/**
 * A draining sweep stops starting rows this long after its request began, so a
 * row already in flight (a Stream call report) still lands inside the ticker's
 * 24 s abort for these targets, with room for a ~5 s cold boot.
 */
// ≈3.3 s setup + ≈0.31 s/session ⇒ ≈40 sessions/run ⇒ ≈80/h at the 30-min cadence.
export const SWEEP_START_DEADLINE_MS = 16_000;

/** True once a sweep that began at `startedAt` must stop starting rows. */
export function startDeadline(startedAt: number = Date.now()): () => boolean {
  const until = startedAt + SWEEP_START_DEADLINE_MS;
  return () => Date.now() >= until;
}
