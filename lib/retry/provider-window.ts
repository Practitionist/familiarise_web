/** Resend keeps an idempotency key for 24 h; automatic replay stops an hour short of that. */
export const PROVIDER_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

export const PROVIDER_WINDOW_EXPIRED = "review:provider_acceptance_unknown";

/**
 * A row the provider never saw (`firstAttemptAt` null) is safe to send at any
 * age; one it may have accepted replays only while its key is still deduped.
 */
export function providerWindowRefusal(
  firstAttemptAt: Date | null,
  now: Date,
): typeof PROVIDER_WINDOW_EXPIRED | null {
  if (!firstAttemptAt) return null;
  return now.getTime() - firstAttemptAt.getTime() >= PROVIDER_REPLAY_WINDOW_MS
    ? PROVIDER_WINDOW_EXPIRED
    : null;
}

/** The single write the anchor needs; `failedEmail` and `failedEmailBatch` both satisfy it. */
export interface FirstAttemptTable {
  updateMany(args: {
    where: { id: string; firstAttemptAt: null };
    data: { firstAttemptAt: Date };
  }): Promise<{ count: number }>;
}

/** Call immediately before the provider request; only the first call sets the anchor. */
export async function stampFirstAttempt(
  table: FirstAttemptTable,
  id: string,
  at: Date,
): Promise<void> {
  await table.updateMany({
    where: { id, firstAttemptAt: null },
    data: { firstAttemptAt: at },
  });
}
