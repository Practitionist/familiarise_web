import * as Sentry from "@sentry/nextjs";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  attemptTrigger,
  type StagedTrigger,
  type TriggerResult,
} from "./outbox";

function report(message: string, err: unknown): void {
  console.error(message, err);
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { subsystem: "novu" },
  });
}

/**
 * #1861 P2r — for a notice whose business write already committed with no
 * transaction left to ride: await the outbox stage so the row exists before
 * the response returns, and defer only the delivery attempt. A row whose
 * attempt never runs (instance frozen after the response) is still drained by
 * the ticker. Never throws.
 */
export async function stageNowAttemptAfter(
  label: string,
  stage: () => Promise<TriggerResult | TriggerResult[]>,
): Promise<void> {
  let results: TriggerResult[];
  try {
    const result = await stage();
    results = Array.isArray(result) ? result : [result];
  } catch (err) {
    report(`Failed to stage ${label}`, err);
    return;
  }
  const rows = results
    .map((r) => r.staged)
    .filter((row): row is StagedTrigger => Boolean(row));
  if (rows.length === 0) return;
  scheduleAfter(() =>
    Promise.all(
      rows.map((row) =>
        attemptTrigger(row).catch((err) =>
          report(`Failed to deliver ${label}`, err),
        ),
      ),
    ),
  );
}
