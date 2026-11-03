import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import {
  newerOf,
  readIdleCompletions,
  type IdleCompletion,
} from "@/lib/cron/idle-skips";
import { jobEnvironment } from "@/lib/cron/run-outcome";
import { freshnessBudgetMinutes } from "@/lib/cron/operational-health";
import {
  JOB_SCHEDULES,
  jobNameFor,
  latestWindowStart,
  TICK_CLAIM_JOB,
  type JobSchedule,
} from "@/lib/cron/schedule";

export const METRICS_DAYS = 7;

/** The environments a run row records in `result.environment`, one per deploy kind. */
export const metricsEnvironmentSchema = z.enum([
  "production",
  "preview",
  "development",
]);
export type MetricsEnvironment = z.infer<typeof metricsEnvironmentSchema>;

/** This deploy's own environment, which the console shows unless another is picked. */
export function defaultMetricsEnvironment(): MetricsEnvironment {
  return metricsEnvironmentSchema.catch("production").parse(jobEnvironment());
}
/** The execution trail's retention, so the last success is always in reach. */
const LAST_SUCCESS_LOOKBACK_DAYS = 90;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** IST has no daylight saving, so a fixed offset gives its calendar day. */
const IST_OFFSET_MS = 330 * MINUTE_MS;

export interface MissedWindow {
  /**
   * `unscheduled`: no ticker target, so nothing to miss.
   * `no-runs`: a non-production deployment has no successful run of its own,
   * so the window cannot be judged there.
   */
  state: "ok" | "missed" | "unscheduled" | "no-runs";
  basis: "slo" | "window" | null;
}

export interface JobRunMetric {
  jobName: string;
  runs: number;
  succeeded: number;
  /** COMPLETED rows whose outcome is `attention`: findings with no item failing, counted in `succeeded`. */
  attention: number;
  /** FAILED rows whose outcome is `partial`: the run finished with some items failing. */
  partial: number;
  /** FAILED rows of every other outcome. */
  failed: number;
  /** CANCELLED rows with outcome `held`: another run held the lease. */
  held: number;
  /** CANCELLED rows that stood down for another reason: a config skip, a maintenance refusal or a pause. */
  skipped: number;
  /** Due ticks the idle probe skipped because the job had no work; they write no run row. */
  idleSkips: number;
  running: number;
  p50Ms: number | null;
  p95Ms: number | null;
  itemsProcessed: number;
  lastSuccessAt: string | null;
  missed: MissedWindow;
  /** One entry per IST day, oldest first. */
  daily: { day: string; runs: number; failures: number }[];
}

export interface JobRunMetrics {
  days: string[];
  /** Every count, percentile and window check reads only this environment's runs. */
  environment: MetricsEnvironment;
  jobs: JobRunMetric[];
}

/** The IST calendar day of an instant, as YYYY-MM-DD. */
export const istDay = (at: Date) =>
  new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The last `count` IST days ending today, oldest first. */
export function istDayKeys(now: Date, count = METRICS_DAYS): string[] {
  return Array.from({ length: count }, (_, i) =>
    istDay(new Date(now.getTime() - (count - 1 - i) * DAY_MS)),
  );
}

/** Execution-row names of every ticker target. */
const TICKER_JOB_NAMES = JOB_SCHEDULES.map((s) => jobNameFor(s.name));

/** The ticker target a job name runs under: its name or override, else the longest `-<target>` suffix. */
export function scheduleForJob(jobName: string): JobSchedule | undefined {
  const exact = JOB_SCHEDULES.find(
    (s) => s.name === jobName || jobNameFor(s.name) === jobName,
  );
  if (exact) return exact;
  return JOB_SCHEDULES.filter((s) => jobName.endsWith(`-${s.name}`)).sort(
    (a, b) => b.name.length - a.name.length,
  )[0];
}

/** The newest calendar window whose first slots (plus a tick of grace) have passed. */
export function latestDueWindowStart(
  schedule: JobSchedule,
  now: Date,
): Date | null {
  const w = schedule.window;
  if (!w) return null;
  const graceMs =
    Math.min(w.windowMinutes, 2 * schedule.everyMinutes + 5) * MINUTE_MS;
  return latestWindowStart(schedule.name, new Date(now.getTime() - graceMs));
}

/** The latest due calendar window has no finished run since it opened. */
function missedWindow(
  schedule: JobSchedule,
  lastSuccessAt: Date | null,
  now: Date,
): boolean {
  const due = latestDueWindowStart(schedule, now);
  // A window opened before the lookback may have a success the trail no longer holds.
  const judgeable =
    due !== null &&
    due.getTime() >= now.getTime() - LAST_SUCCESS_LOOKBACK_DAYS * DAY_MS;
  return judgeable && (!lastSuccessAt || lastSuccessAt < due);
}

/**
 * Missed when a calendar-windowed job's latest due window passed with no
 * finished run, or when the job's freshness budget has lapsed.
 */
export function assessMissedWindow(args: {
  jobName: string;
  lastSuccessAt: Date | null;
  now: Date;
}): MissedWindow {
  const { jobName, lastSuccessAt, now } = args;
  const schedule = scheduleForJob(jobName);
  if (!schedule) return { state: "unscheduled", basis: null };
  if (schedule.window && missedWindow(schedule, lastSuccessAt, now)) {
    return { state: "missed", basis: "window" };
  }
  const budgetMs = freshnessBudgetMinutes(schedule.name) * MINUTE_MS;
  const missed =
    !lastSuccessAt || now.getTime() - lastSuccessAt.getTime() > budgetMs;
  return { state: missed ? "missed" : "ok", basis: "slo" };
}

export interface MetricInputs {
  now: Date;
  environment: MetricsEnvironment;
  counts: {
    jobName: string;
    status: string;
    /** `result.outcome`, null on rows written before outcomes were recorded. */
    outcome: string | null;
    count: number;
    itemsProcessed: number;
  }[];
  percentiles: { jobName: string; p50: number | null; p95: number | null }[];
  daily: { jobName: string; day: string; runs: number; failures: number }[];
  lastSuccess: { jobName: string; endedAt: Date | null }[];
  /** Idle skips count as finished runs that found no work. */
  idle?: IdleCompletion[];
}

const roundMs = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Math.round(v);

/**
 * Folds the four reads into one row per job; missed jobs sort first. A job off
 * the ticker drops out once it has no run in 7 days and no success in 90.
 */
export function buildJobRunMetrics(input: MetricInputs): JobRunMetrics {
  const days = istDayKeys(input.now);
  const names = new Set<string>([
    ...input.counts.map((c) => c.jobName),
    ...input.lastSuccess.map((l) => l.jobName),
    ...TICKER_JOB_NAMES,
  ]);
  const jobs = [...names].map((jobName): JobRunMetric => {
    const mine = input.counts.filter((c) => c.jobName === jobName);
    const sum = (match: (c: MetricInputs["counts"][number]) => boolean) =>
      mine.filter(match).reduce((s, c) => s + c.count, 0);
    const failedRows = sum((c) => c.status === "FAILED");
    const partial = sum(
      (c) => c.status === "FAILED" && c.outcome === "partial",
    );
    const cancelled = sum((c) => c.status === "CANCELLED");
    const held = sum((c) => c.status === "CANCELLED" && c.outcome === "held");
    const pct = input.percentiles.find((p) => p.jobName === jobName);
    const idle = input.idle?.find((i) => i.jobName === jobName);
    const last = newerOf(
      input.lastSuccess.find((l) => l.jobName === jobName)?.endedAt ?? null,
      idle?.endedAt,
    );
    const perDay = new Map(
      input.daily.filter((d) => d.jobName === jobName).map((d) => [d.day, d]),
    );
    return {
      jobName,
      runs: mine.reduce((s, c) => s + c.count, 0),
      succeeded: sum((c) => c.status === "COMPLETED"),
      attention: sum(
        (c) => c.status === "COMPLETED" && c.outcome === "attention",
      ),
      partial,
      failed: failedRows - partial,
      held,
      skipped: cancelled - held,
      idleSkips: idle?.skips ?? 0,
      running: sum((c) => c.status === "RUNNING"),
      p50Ms: roundMs(pct?.p50),
      p95Ms: roundMs(pct?.p95),
      itemsProcessed: mine.reduce((s, c) => s + c.itemsProcessed, 0),
      lastSuccessAt: last?.toISOString() ?? null,
      missed:
        !last && input.environment !== "production"
          ? { state: "no-runs", basis: null }
          : assessMissedWindow({
              jobName,
              lastSuccessAt: last,
              now: input.now,
            }),
      daily: days.map((day) => ({
        day,
        runs: perDay.get(day)?.runs ?? 0,
        failures: perDay.get(day)?.failures ?? 0,
      })),
    };
  });
  const missedFirst = (j: JobRunMetric) =>
    j.missed.state === "missed" ? 0 : 1;
  jobs.sort(
    (a, b) =>
      missedFirst(a) - missedFirst(b) ||
      b.failed - a.failed ||
      (a.jobName < b.jobName ? -1 : 1),
  );
  return { days, environment: input.environment, jobs };
}

const CountRow = z.object({
  jobName: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  count: z.number(),
  itemsProcessed: z.number(),
});
const PercentileRow = z.object({
  jobName: z.string(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
});
const DailyRow = z.object({
  jobName: z.string(),
  day: z.string(),
  runs: z.number(),
  failures: z.number(),
});

/**
 * Seven days of one environment's SystemJobExecution rows per job, in five
 * statements run in turn; the ticker's slot-claim rows are not job runs, but
 * the idle skips they list are read as no-work runs. Outcome counts, percentiles and IST-day buckets have no Prisma
 * groupBy form, so those are parameterised read-only `$queryRaw`; the last
 * finish uses groupBy.
 */
export async function readJobRunMetrics(
  environment: MetricsEnvironment,
  now = new Date(),
): Promise<JobRunMetrics> {
  const since = new Date(now.getTime() - METRICS_DAYS * DAY_MS);
  const lookback = new Date(
    now.getTime() - LAST_SUCCESS_LOOKBACK_DAYS * DAY_MS,
  );

  const counts = z.array(CountRow).parse(
    await prisma.$queryRaw(Prisma.sql`
      SELECT "jobName", "status"::text AS status, "result"->>'outcome' AS outcome,
        count(*)::int AS "count",
        coalesce(sum("itemsProcessed"), 0)::int AS "itemsProcessed"
      FROM "SystemJobExecution"
      WHERE "startedAt" >= ${since}
        AND "jobName" <> ${TICK_CLAIM_JOB}
        AND "result"->>'environment' = ${environment}
      GROUP BY 1, 2, 3`),
  );
  const percentiles = z.array(PercentileRow).parse(
    await prisma.$queryRaw(Prisma.sql`
      SELECT "jobName",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs")::float8 AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float8 AS p95
      FROM "SystemJobExecution"
      WHERE "startedAt" >= ${since}
        AND "jobName" <> ${TICK_CLAIM_JOB}
        AND "result"->>'environment' = ${environment}
        AND "durationMs" IS NOT NULL
        AND "status" IN ('COMPLETED', 'FAILED')
      GROUP BY "jobName"`),
  );
  const daily = z.array(DailyRow).parse(
    await prisma.$queryRaw(Prisma.sql`
      SELECT "jobName",
        to_char(("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
        count(*)::int AS runs,
        (count(*) FILTER (WHERE "status" = 'FAILED'))::int AS failures
      FROM "SystemJobExecution"
      WHERE "startedAt" >= ${since}
        AND "jobName" <> ${TICK_CLAIM_JOB}
        AND "result"->>'environment' = ${environment}
      GROUP BY 1, 2`),
  );
  // A partial run ran to the end, the same rule the freshness budgets use.
  const lastSuccess = await prisma.systemJobExecution.groupBy({
    by: ["jobName"],
    where: {
      jobName: { not: TICK_CLAIM_JOB },
      OR: [
        { status: "COMPLETED" },
        { status: "FAILED", result: { path: ["outcome"], equals: "partial" } },
      ],
      startedAt: { gte: lookback },
      result: { path: ["environment"], equals: environment },
    },
    _max: { endedAt: true },
  });

  return buildJobRunMetrics({
    now,
    environment,
    counts,
    percentiles,
    daily,
    lastSuccess: lastSuccess.map((l) => ({
      jobName: l.jobName,
      endedAt: l._max.endedAt,
    })),
    idle: await readIdleCompletions(prisma, environment, lookback, since),
  });
}
