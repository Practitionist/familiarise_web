import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bearerMatches } from "@/lib/cron/cleanup-route";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "@/lib/cron/operational-health";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", Vary: "Authorization" };
const skipResultSchema = z.object({ reason: z.string() });
const CONFIG_SKIP_SUFFIX = " not configured";

/** Read-only external absence probe; never invokes or repairs a job. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!secret || !bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: HEADERS },
    );
  }
  const environment =
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.SENTRY_ENVIRONMENT;
  if (!environment) {
    return NextResponse.json(
      { healthy: false, error: "JOB_ENVIRONMENT_UNCONFIGURED" },
      { status: 503, headers: HEADERS },
    );
  }
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const now = new Date();
    const paging = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
      (job) => job.tier === "paging",
    );
    const lookback = (minutes: number) =>
      new Date(now.getTime() - minutes * 60_000);
    // Each job is read back only as far as its own budget, so the scan stays bounded.
    // A partial run ran to the end and a config skip proves the job was reached; watched jobs belong to the console.
    const rows = await prisma.systemJobExecution.groupBy({
      by: ["jobName", "status"],
      where: {
        result: { path: ["environment"], equals: environment },
        AND: [
          {
            OR: paging.map((job) => ({
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
    // An idle skip found no work, so it is as fresh as a finished run.
    const { readIdleCompletions } = await import("@/lib/cron/idle-skips");
    const idle = await readIdleCompletions(
      prisma,
      environment,
      lookback(Math.max(...paging.map((job) => job.maxAgeMinutes))),
    );
    const latest = (row: (typeof rows)[number]) => ({
      jobName: row.jobName,
      endedAt: row._max.endedAt,
    });
    const report = assessOperationalCompletions({
      completions: [
        ...rows.filter((row) => row.status !== "CANCELLED").map(latest),
        ...idle,
      ],
      configSkips: rows.filter((row) => row.status === "CANCELLED").map(latest),
      now,
      tier: "paging",
    });
    // The last day's config-skip reasons, listed for operators.
    const skips = await prisma.systemJobExecution
      .findMany({
        where: {
          status: "CANCELLED",
          createdAt: { gte: new Date(now.getTime() - 26 * 60 * 60 * 1000) },
          AND: [
            { result: { path: ["environment"], equals: environment } },
            { result: { path: ["outcome"], equals: "skipped" } },
            {
              result: {
                path: ["reason"],
                string_ends_with: CONFIG_SKIP_SUFFIX,
              },
            },
          ],
        },
        distinct: ["jobName"],
        orderBy: { createdAt: "desc" },
        select: { jobName: true, createdAt: true, result: true },
        take: 50,
      })
      .catch(() => []);
    const configSkips = skips.map((row) => ({
      jobName: row.jobName,
      reason: skipResultSchema.safeParse(row.result).data?.reason ?? null,
      at: row.createdAt.toISOString(),
    }));
    return NextResponse.json(
      { ...report, configSkips },
      {
        status: report.healthy ? 200 : 503,
        headers: HEADERS,
      },
    );
  } catch {
    return NextResponse.json(
      { healthy: false, error: "JOB_HISTORY_UNAVAILABLE" },
      { status: 503, headers: HEADERS },
    );
  }
}
