import { AsyncLocalStorage } from "node:async_hooks";
import {
  emptyRunCounters,
  setRunCounterSink,
  type RunCounters,
} from "@/lib/cron/run-counters";

/** What one cleanup-route run, or one admin dispatch, knows about itself while its job runs. */
export interface RunContext {
  /** Execution rows `withCronLock` opened inside this run. */
  runIds: string[];
  /** `cron`, `github-actions`, `admin:<userId>` or `admin-drain:<userId>`. */
  triggeredBy: string;
  tickId?: string;
  opsActionLogId?: string;
  counters: RunCounters;
  /** Rows whose own finish write landed, with the checkpoint each kept; only these are rewritten by the route. */
  finished: Map<string, { checkpoint: string | null } | null>;
}

export interface RunContextInit {
  triggeredBy: string;
  tickId?: string;
  opsActionLogId?: string;
}

const storage = new AsyncLocalStorage<RunContext>();

setRunCounterSink((name, by) => {
  const run = storage.getStore();
  if (run) run.counters[name] += by;
});

export function withRunContext<T>(
  init: RunContextInit,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    {
      ...init,
      runIds: [],
      counters: emptyRunCounters(),
      finished: new Map(),
    },
    fn,
  );
}

/** The active run, or undefined outside one (CLI entrypoints and most tests). */
export function currentRun(): RunContext | undefined {
  return storage.getStore();
}

export { noteRunCounter as noteCounter } from "@/lib/cron/run-counters";

export function noteRunId(id: string): void {
  storage.getStore()?.runIds.push(id);
}

export function noteRunFinished(
  id: string,
  checkpoint: { checkpoint: string | null } | null,
): void {
  storage.getStore()?.finished.set(id, checkpoint);
}

/** The trigger a scheduler-driven run records when no admin context wraps it. */
export function schedulerTrigger(): string {
  return process.env.GITHUB_ACTIONS ? "github-actions" : "cron";
}

const ADMIN_TRIGGER = /^admin(?:-drain)?:(.+)$/;

/** The admin user who started the active run, for money writes that attribute a maker. */
export function adminActorId(): string | undefined {
  return ADMIN_TRIGGER.exec(currentRun()?.triggeredBy ?? "")?.[1];
}
