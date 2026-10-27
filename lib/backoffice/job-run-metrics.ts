import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "@/lib/cron/operational-health";
import {
  JOB_SCHEDULES,
  jobNameFor,
  windowStartFor,
  type JobSchedule,
} from "@/lib/cron/schedule";

export const METRICS_DAYS = 7;
/** The execution trail's retention, so the last success is always in reach. */
const LAST_SUCCESS_LOOKBACK_DAYS = 90;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** IST has no daylight saving, so a fixed offset gives its calendar day. */
const IST_OFFSET_MS = 330 * MINUTE_MS;
/** How far back a calendar window (weekly, monthly, quarterly) is searched. */
const WINDOW_SEARCH_DAYS = 400;

export interface MissedWindow {
  /**
   * `unscheduled`: no SLO and no ticker cadence, so nothing to miss.
   * `no-runs`: a non-production deployment has no successful run of its own,
   * so the window cannot be judged there.
   */
  state: "ok" | "missed" | "unscheduled" | "no-runs";
  basis: "slo" | "interval" | "window" | null;
}

export interface JobRunMetric {
  jobName: string;
  runs: number;
  succeeded: number;
  failed: number;
  /** CANCELLED rows: the run found the lease held and stood down. */
  held: number;
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
  /** Last success and the missed flag count only this environment's runs. */
  environment: string | null;
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

/** Execution-row names of every ticker target that writes one. */
const TICKER_JOB_NAMES = JOB_SCHEDULES.map((s) => jobNameFor(s.name)).filter(
  (name): name is string => name !== null,
);

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
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (let d = 0; d <= WINDOW_SEARCH_DAYS; d++) {
    const start = new Date(today - d * DAY_MS + w.startMinuteUtc * MINUTE_MS);
    if (start.getTime() + graceMs > now.getTime()) continue;
    if (windowStartFor(schedule.name, start)?.getTime() === start.getTime()) {
      return start;
    }
  }
  return null;
}

/**
 * Missed when the job's completion SLO has lapsed; else, for a ticker job, when
 * two interval slots (plus a tick) passed with no success, or the latest due
 * calendar window has no success since it opened.
 */
export function assessMissedWindow(args: {
  jobName: string;
  lastSuccessAt: Date | null;
  now: Date;
}): MissedWindow {
  const { jobName, lastSuccessAt, now } = args;
  if (OPERATIONAL_COMPLETION_REQUIREMENTS.some((r) => r.jobName === jobName)) {
    const { jobs } = assessOperationalCompletions(
      [{ jobName, endedAt: lastSuccessAt }],
      now,
    );
    const overdue = jobs.find((j) => j.jobName === jobName)?.overdue ?? true;
    return { state: overdue ? "missed" : "ok", basis: "slo" };
  }
  const schedule = scheduleForJob(jobName);
  if (!schedule) return { state: "unscheduled", basis: null };
  if (schedule.window) {
    const due = latestDueWindowStart(schedule, now);
    // A window opened before the lookback may have a success the trail no longer holds.
    const judgeable =
      due !== null &&
      due.getTime() >= now.getTime() - LAST_SUCCESS_LOOKBACK_DAYS * DAY_MS;
    const missed = judgeable && (!lastSuccessAt || lastSuccessAt < due);
    return { state: missed ? "missed" : "ok", basis: "window" };
  }
  const limitMs = (2 * schedule.everyMinutes + 5) * MINUTE_MS;
  const missed =
    !lastSuccessAt || now.getTime() - lastSuccessAt.getTime() > limitMs;
  return { state: missed ? "missed" : "ok", basis: "interval" };
}

export interface MetricInputs {
  now: Date;
  environment: string | null;
  counts: {
    jobName: string;
    status: string;
    count: number;
    itemsProcessed: number;
  }[];
  percentiles: { jobName: string; p50: number | null; p95: number | null }[];
  daily: { jobName: string; day: string; runs: number; failures: number }[];
  lastSuccess: { jobName: string; endedAt: Date | null }[];
}

const roundMs = (v: number | null | undefined) =>
  v === null || v === undefined ? null : Math.round(v);

/**
 * Folds the four reads into one row per job; missed jobs sort first. A job off
 * the ticker with no SLO drops out once it has no run in 7 days and no success in 90.
 */
export function buildJobRunMetrics(input: MetricInputs): JobRunMetrics {
  const days = istDayKeys(input.now);
  const names = new Set<string>([
    ...input.counts.map((c) => c.jobName),
    ...input.lastSuccess.map((l) => l.jobName),
    ...OPERATIONAL_COMPLETION_REQUIREMENTS.map((r) => r.jobName),
    ...TICKER_JOB_NAMES,
  ]);
  const jobs = [...names].map((jobName): JobRunMetric => {
    const mine = input.counts.filter((c) => c.jobName === jobName);
    const byStatus = (status: string) =>
      mine.find((c) => c.status === status)?.count ?? 0;
    const pct = input.percentiles.find((p) => p.jobName === jobName);
    const last =
      input.lastSuccess.find((l) => l.jobName === jobName)?.endedAt ?? null;
    const perDay = new Map(
      input.daily.filter((d) => d.jobName === jobName).map((d) => [d.day, d]),
    );
    return {
      jobName,
      runs: mine.reduce((s, c) => s + c.count, 0),
      succeeded: byStatus("COMPLETED"),
      failed: byStatus("FAILED"),
      held: byStatus("CANCELLED"),
      running: byStatus("RUNNING"),
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
 * Seven days of SystemJobExecution per job, in four statements run in turn.
 * Percentiles and IST-day buckets have no Prisma groupBy form, so those two
 * are parameterised read-only `$queryRaw`; the counts and last success use groupBy.
 */
export async function readJobRunMetrics(
  now = new Date(),
): Promise<JobRunMetrics> {
  const since = new Date(now.getTime() - METRICS_DAYS * DAY_MS);
  const environment =
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.SENTRY_ENVIRONMENT ??
    null;

  const counts = await prisma.systemJobExecution.groupBy({
    by: ["jobName", "status"],
    where: { startedAt: { gte: since } },
    _count: { _all: true },
    _sum: { itemsProcessed: true },
  });
  const percentiles = z.array(PercentileRow).parse(
    await prisma.$queryRaw(Prisma.sql`
      SELECT "jobName",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs")::float8 AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float8 AS p95
      FROM "SystemJobExecution"
      WHERE "startedAt" >= ${since}
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
      GROUP BY 1, 2`),
  );
  const lastSuccess = await prisma.systemJobExecution.groupBy({
    by: ["jobName"],
    where: {
      status: "COMPLETED",
      startedAt: {
        gte: new Date(now.getTime() - LAST_SUCCESS_LOOKBACK_DAYS * DAY_MS),
      },
      ...(environment
        ? { result: { path: ["environment"], equals: environment } }
        : {}),
    },
    _max: { endedAt: true },
  });

  return buildJobRunMetrics({
    now,
    environment,
    counts: counts.map((c) => ({
      jobName: c.jobName,
      status: c.status,
      count: c._count._all,
      itemsProcessed: c._sum.itemsProcessed ?? 0,
    })),
    percentiles,
    daily,
    lastSuccess: lastSuccess.map((l) => ({
      jobName: l.jobName,
      endedAt: l._max.endedAt,
    })),
  });
}
