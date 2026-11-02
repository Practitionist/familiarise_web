import { noteRunFailure } from "@/lib/cron/run-telemetry";
import { entityIdOf } from "@/lib/observability/entity-id";
import { reportSentryError, type ReportOpts } from "@/lib/observability/report";

const SAMPLE_SIZE = 10;

type Bucket = {
  first: unknown;
  count: number;
  sample: Array<Record<string, unknown>>;
  level: ReportOpts["level"];
  expected: boolean;
};

export interface RunFailureReporter {
  add(
    op: string,
    error: unknown,
    context?: Record<string, unknown>,
    opts?: Pick<ReportOpts, "level" | "expected">,
  ): void;
  /** Sends one event per op that failed, then resets. */
  flush(): void;
}

/** The attempt number a caller put in its failure context, if any. */
function attemptOf(context: Record<string, unknown>): number | null {
  for (const key of ["attempt", "attempts", "retryCount"]) {
    const value = context[key];
    if (Number.isInteger(value) && Number(value) >= 0) return Number(value);
  }
  return null;
}

/**
 * Collects per-row failures during a sweep so a run costs one Sentry event per
 * failing op however many rows failed; `extra` carries the count and a sample.
 * Each failure is also listed, ids only, on the active run's execution row.
 */
export function createRunFailureReporter(
  subsystem: string,
): RunFailureReporter {
  const buckets = new Map<string, Bucket>();
  return {
    add(op, error, context = {}, opts = {}) {
      noteRunFailure({
        entityId: entityIdOf(context) ?? null,
        reason: op.slice(0, 120),
        attempt: attemptOf(context),
      });
      const bucket = buckets.get(op);
      if (bucket) {
        bucket.count += 1;
        if (bucket.sample.length < SAMPLE_SIZE) bucket.sample.push(context);
        return;
      }
      buckets.set(op, {
        first: error,
        count: 1,
        sample: [context],
        level: opts.level,
        expected: opts.expected ?? false,
      });
    },
    flush() {
      const pending = [...buckets];
      buckets.clear();
      for (const [op, b] of pending) {
        reportSentryError(b.first, {
          subsystem,
          op,
          level: b.level,
          expected: b.expected,
          fingerprint: [subsystem, op],
          extra: { count: b.count, sample: b.sample },
        });
      }
    },
  };
}
