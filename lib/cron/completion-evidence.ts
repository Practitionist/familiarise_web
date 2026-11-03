import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Db } from "@/lib/prisma";
import type {
  CompletionRequirement,
  JobCompletion,
  SloTier,
} from "@/lib/cron/operational-health";

const MINUTE_MS = 60_000;
/** Finished runs other than no-op completions are kept this long by the job-history prune. */
const RUN_HISTORY_DAYS = 180;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A config skip's reason ends with this (`ConfigSkip` in lib/cron/config-skip.ts). */
const CONFIG_SKIP_SUFFIX = " not configured";

/** Run rows of one environment that did nothing because a required setting is absent. */
export function configSkipWhere(
  environment: string,
): Prisma.SystemJobExecutionWhereInput {
  return {
    status: "CANCELLED",
    AND: [
      { result: { path: ["environment"], equals: environment } },
      { result: { path: ["outcome"], equals: "skipped" } },
      { result: { path: ["reason"], string_ends_with: CONFIG_SKIP_SUFFIX } },
    ],
  };
}

/**
 * Each job's newest evidence of a run, read back only as far as its own budget:
 * a finished or partial run, an idle skip, or a config skip (which proves the job was reached).
 */
export async function readCompletionEvidence(
  db: Db,
  environment: string,
  requirements: readonly CompletionRequirement[],
  now: Date,
): Promise<{ completions: JobCompletion[]; configSkips: JobCompletion[] }> {
  if (requirements.length === 0) return { completions: [], configSkips: [] };
  const lookback = (minutes: number) =>
    new Date(now.getTime() - minutes * MINUTE_MS);
  const rows = await db.systemJobExecution.groupBy({
    by: ["jobName", "status"],
    where: {
      result: { path: ["environment"], equals: environment },
      AND: [
        {
          OR: requirements.map((job) => ({
            jobName: job.jobName,
            startedAt: { gte: lookback(job.maxAgeMinutes) },
          })),
        },
        {
          OR: [
            { status: "COMPLETED" },
            {
              status: "FAILED",
              result: { path: ["outcome"], equals: "partial" },
            },
            {
              status: "CANCELLED",
              AND: [
                { result: { path: ["outcome"], equals: "skipped" } },
                {
                  result: {
                    path: ["reason"],
                    string_ends_with: CONFIG_SKIP_SUFFIX,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    _max: { endedAt: true },
  });
  const { readIdleCompletions } = await import("@/lib/cron/idle-skips");
  const idle = await readIdleCompletions(
    db,
    environment,
    lookback(Math.max(...requirements.map((job) => job.maxAgeMinutes))),
  );
  const latest = (row: (typeof rows)[number]) => ({
    jobName: row.jobName,
    endedAt: row._max.endedAt,
  });
  return {
    completions: [
      ...rows.filter((row) => row.status !== "CANCELLED").map(latest),
      ...idle,
    ],
    configSkips: rows.filter((row) => row.status === "CANCELLED").map(latest),
  };
}

export interface StandingConfigSkip {
  jobName: string;
  tier: SloTier;
  reason: string | null;
  /** The earliest config skip since the job's last real run, within retained history. */
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const skipReasonSchema = z.object({ reason: z.string() });

/**
 * Jobs whose newest run is a config skip and still inside their freshness budget,
 * each with the start of its consecutive skip streak. A COMPLETED or FAILED run ends a streak.
 */
export async function readStandingConfigSkips(
  db: Db,
  environment: string,
  requirements: readonly CompletionRequirement[],
  now: Date,
): Promise<StandingConfigSkip[]> {
  const since = new Date(now.getTime() - RUN_HISTORY_DAYS * DAY_MS);
  const byJob = new Map(requirements.map((job) => [job.jobName, job]));
  const latest = await db.systemJobExecution.groupBy({
    by: ["jobName"],
    where: { ...configSkipWhere(environment), startedAt: { gte: since } },
    _max: { startedAt: true },
  });
  const current = latest.flatMap((row) => {
    const job = byJob.get(row.jobName);
    const at = row._max.startedAt;
    return job &&
      at &&
      now.getTime() - at.getTime() <= job.maxAgeMinutes * MINUTE_MS
      ? [{ jobName: row.jobName, tier: job.tier, lastSeenAt: at }]
      : [];
  });
  if (current.length === 0) return [];
  const real = await db.systemJobExecution.groupBy({
    by: ["jobName"],
    where: {
      jobName: { in: current.map((job) => job.jobName) },
      status: { in: ["COMPLETED", "FAILED"] },
      result: { path: ["environment"], equals: environment },
      startedAt: { gte: since },
    },
    _max: { startedAt: true },
  });
  const lastReal = new Map(
    real.map((row) => [row.jobName, row._max.startedAt]),
  );
  const standing = current.filter((job) => {
    const ran = lastReal.get(job.jobName);
    return !ran || ran < job.lastSeenAt;
  });
  if (standing.length === 0) return [];
  const first = await db.systemJobExecution.groupBy({
    by: ["jobName"],
    where: {
      ...configSkipWhere(environment),
      OR: standing.map((job) => ({
        jobName: job.jobName,
        startedAt: { gt: lastReal.get(job.jobName) ?? since },
      })),
    },
    _min: { startedAt: true },
  });
  const reasons = await db.systemJobExecution.findMany({
    where: {
      ...configSkipWhere(environment),
      OR: standing.map((job) => ({
        jobName: job.jobName,
        startedAt: job.lastSeenAt,
      })),
    },
    select: { jobName: true, result: true },
    take: standing.length,
  });
  return standing.map((job) => ({
    ...job,
    reason:
      skipReasonSchema.safeParse(
        reasons.find((row) => row.jobName === job.jobName)?.result,
      ).data?.reason ?? null,
    firstSeenAt:
      first.find((row) => row.jobName === job.jobName)?._min.startedAt ??
      job.lastSeenAt,
  }));
}
