/** A run that did nothing because a required setting is absent; its route answers 200. */
export type ConfigSkip = `${string} not configured`;

/**
 * Logs a missing-config skip. It never reaches Sentry: the run row records it
 * as outcome `skipped` with this reason, which the console and `/api/health/jobs` show.
 */
export function reportConfigSkip(job: string, skipped: ConfigSkip): void {
  console.warn(JSON.stringify({ event: "cron.config-skip", job, skipped }));
}
