/**
 * The one retry schedule the outbox drains share: FailedEmail, the outbound
 * webhook worker and the erasure Stream-revocation retry (#1593). Keyed by the
 * attempt number AFTER incrementing: a row at `attempts = 0` that was just
 * tried once looks up `BACKOFF_MS[1]` for when to try next; past the last
 * slot the schedule stays flat at its longest wait.
 */
export const BACKOFF_MS: Record<number, number> = {
  1: 60_000, // 1 min
  2: 5 * 60_000, // 5 min
  3: 30 * 60_000, // 30 min
  4: 2 * 60 * 60_000, // 2 h
  5: 8 * 60 * 60_000, // 8 h
};

const LAST_SLOT = Math.max(...Object.keys(BACKOFF_MS).map(Number));

/** When to try again, given the attempt count AFTER the one that just failed. */
export function nextRetryAt(attempts: number, now: Date = new Date()): Date {
  const slot = Math.min(Math.max(attempts, 1), LAST_SLOT);
  return new Date(now.getTime() + BACKOFF_MS[slot]);
}
