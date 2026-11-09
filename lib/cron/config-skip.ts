/** A run that did nothing because a required setting is absent; its route answers 200. */
export type ConfigSkip = `${string} not configured`;

/**
 * Logs a missing-config skip. It never reaches Sentry: the run row records it
 * as outcome `skipped` with this reason, which the console and `/api/health/jobs` show.
 */
export function reportConfigSkip(job: string, skipped: ConfigSkip): void {
  console.warn(JSON.stringify({ event: "cron.config-skip", job, skipped }));
}

/** The skip every GST job records while PLATFORM_GSTIN is unset. */
export const GST_UNREGISTERED_SKIP: ConfigSkip =
  "PLATFORM_GSTIN not configured";

/** A skip that is the decided steady state: a GST job while the platform is unregistered. */
export function isExpectedConfigSkip(reason: string | null): boolean {
  return (
    reason === GST_UNREGISTERED_SKIP && !process.env.PLATFORM_GSTIN?.trim()
  );
}
