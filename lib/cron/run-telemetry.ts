import { z } from "zod";
import type { TelemetryOutcome } from "@/lib/observability/betterstack-telemetry";
import { ENTITY_ID_PATTERN } from "@/lib/observability/entity-id";

/** Failures kept on one run row; the rest are counted in `failuresOverflow`. */
export const MAX_RUN_FAILURES = 50;

const count = z.number().int().nonnegative();

/** `SystemJobExecution.result.telemetry`: the run's Better Stack sends and rejections by answer. */
export const runTelemetrySchema = z
  .object({
    sent: count,
    rejected: z
      .object({
        "402": count,
        "403": count,
        "5xx": count,
        network: count,
        other: count,
      })
      .strict(),
  })
  .strict();

/** One entry of `SystemJobExecution.result.failures`: ids and a failure class, never personal data. */
export const runFailureSchema = z
  .object({
    entityId: z.string().regex(ENTITY_ID_PATTERN).nullable(),
    reason: z.string().min(1).max(120),
    attempt: count.nullable(),
  })
  .strict();

const runTelemetryResultSchema = z
  .object({
    telemetry: runTelemetrySchema.optional(),
    failures: z.array(runFailureSchema).max(MAX_RUN_FAILURES).optional(),
    failuresOverflow: count.optional(),
  })
  .strict();

export type RunFailure = z.infer<typeof runFailureSchema>;
type RunTelemetryCounts = z.infer<typeof runTelemetrySchema>;
export type RunTelemetryResult = z.infer<typeof runTelemetryResultSchema>;

export interface RunTelemetryState {
  counts: RunTelemetryCounts;
  failures: RunFailure[];
  failuresOverflow: number;
  pending: Set<Promise<TelemetryOutcome>>;
}

export function emptyRunTelemetry(): RunTelemetryState {
  return {
    counts: {
      sent: 0,
      rejected: { "402": 0, "403": 0, "5xx": 0, network: 0, other: 0 },
    },
    failures: [],
    failuresOverflow: 0,
    pending: new Set(),
  };
}

export function trackTelemetrySend(
  state: RunTelemetryState,
  sending: Promise<TelemetryOutcome>,
): void {
  state.pending.add(sending);
  void sending.then((outcome) => {
    state.pending.delete(sending);
    if (outcome === "sent") state.counts.sent += 1;
    else if (outcome !== "skipped") state.counts.rejected[outcome] += 1;
  });
}

export function addRunFailure(
  state: RunTelemetryState,
  failure: RunFailure,
): void {
  if (state.failures.length < MAX_RUN_FAILURES) state.failures.push(failure);
  else state.failuresOverflow += 1;
}

/** Waits for the run's in-flight sends, each bounded by the emitter's 2 s timeout. */
export async function settleTelemetry(state: RunTelemetryState): Promise<void> {
  if (state.pending.size > 0) await Promise.allSettled([...state.pending]);
}

/** The run row's `telemetry`, `failures` and `failuresOverflow` keys, each omitted when empty; an invalid shape writes none. */
export function runTelemetryResult(
  state: RunTelemetryState,
): RunTelemetryResult {
  const { counts } = state;
  const attempted =
    counts.sent + Object.values(counts.rejected).reduce((a, b) => a + b, 0);
  const parsed = runTelemetryResultSchema.safeParse({
    ...(attempted > 0 ? { telemetry: counts } : {}),
    ...(state.failures.length > 0 ? { failures: state.failures } : {}),
    ...(state.failuresOverflow > 0
      ? { failuresOverflow: state.failuresOverflow }
      : {}),
  });
  return parsed.success ? parsed.data : {};
}

type RunFailureSink = (failure: RunFailure) => void;
let failureSink: RunFailureSink | null = null;

/** Installed by the run context; leaf module, so the failure reporter needs no Node imports. */
export function setRunFailureSink(next: RunFailureSink): void {
  failureSink = next;
}

export function noteRunFailure(failure: RunFailure): void {
  failureSink?.(failure);
}
