import { reportSentryMessage } from "@/lib/observability/report";

/** A run that did nothing because a required setting is absent; its route answers 200. */
export type ConfigSkip = `${string} not configured`;

/** One hourly slot: only the first ticker slot of a window warns. */
const FIRST_SLOT_MS = 60 * 60 * 1000;

/**
 * Logs a missing-config skip every run and warns Sentry only on the first slot
 * of the job's ticker window, so a daily window warns once per UTC day.
 */
export function reportConfigSkip(
  job: string,
  skipped: ConfigSkip,
  windowStart: Date | undefined,
  now: Date = new Date(),
): void {
  console.warn(JSON.stringify({ event: "cron.config-skip", job, skipped }));
  if (!windowStart || now.getTime() - windowStart.getTime() >= FIRST_SLOT_MS) {
    return;
  }
  reportSentryMessage(`${job} skipped: ${skipped}`, {
    subsystem: "cron",
    op: "config-skip",
    expected: true,
    level: "warning",
    tags: { job },
    fingerprint: ["cron-config-skip", job],
  });
}
