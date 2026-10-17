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

/**
 * Collects per-row failures during a sweep so a run costs one Sentry event per
 * failing op however many rows failed; `extra` carries the count and a sample.
 */
export function createRunFailureReporter(
  subsystem: string,
): RunFailureReporter {
  const buckets = new Map<string, Bucket>();
  return {
    add(op, error, context = {}, opts = {}) {
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
