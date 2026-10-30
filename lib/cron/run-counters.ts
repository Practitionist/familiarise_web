/** Per-run correctness counters, persisted in `SystemJobExecution.result.counters`. */
export const RUN_COUNTER_NAMES = [
  "casMiss",
  "serializationRetry",
  "deadlockOrLockTimeout",
  "poolTimeout",
  "leaseLost",
  "leaseTakeover",
] as const;

export type RunCounterName = (typeof RUN_COUNTER_NAMES)[number];
export type RunCounters = Record<RunCounterName, number>;

export function emptyRunCounters(): RunCounters {
  return {
    casMiss: 0,
    serializationRetry: 0,
    deadlockOrLockTimeout: 0,
    poolTimeout: 0,
    leaseLost: 0,
    leaseTakeover: 0,
  };
}

type RunCounterSink = (name: RunCounterName, by: number) => void;
let sink: RunCounterSink | null = null;

// Leaf module with no Node imports, because client bundles reach the CAS helpers; run-context installs the sink.
export function setRunCounterSink(next: RunCounterSink): void {
  sink = next;
}

export function noteRunCounter(name: RunCounterName, by = 1): void {
  sink?.(name, by);
}

/** A CAS update matched zero rows: another writer moved the row first. */
export function casMiss(): void {
  noteRunCounter("casMiss");
}
