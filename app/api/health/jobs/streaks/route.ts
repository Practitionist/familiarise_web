import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/cron/cleanup-route";
import { jobNameFor, TARGETS, type Target } from "@/lib/cron/schedule";
import type { StreakReport } from "@/lib/cron/failure-streak";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", Vary: "Authorization" };
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const KNOWN_TARGETS: ReadonlySet<string> = new Set(TARGETS);

function isTarget(name: string): name is Target {
  return KNOWN_TARGETS.has(name);
}

/** Read-only: when each requested target's job last COMPLETED and last FAILED, for the ticker's escalation and background outcomes. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
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
      { error: "JOB_ENVIRONMENT_UNCONFIGURED" },
      { status: 503, headers: HEADERS },
    );
  }
  const jobByTarget = new Map<string, string>();
  for (const name of (request.nextUrl.searchParams.get("targets") ?? "")
    .split(",")
    .filter(isTarget)) {
    jobByTarget.set(name, jobNameFor(name));
  }
  if (jobByTarget.size === 0) {
    return NextResponse.json({}, { headers: HEADERS });
  }
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const since = new Date(Date.now() - HISTORY_MS);
    const rows = await prisma.systemJobExecution.groupBy({
      by: ["jobName", "status"],
      where: {
        jobName: { in: [...new Set(jobByTarget.values())] },
        status: { in: ["COMPLETED", "FAILED"] },
        result: { path: ["environment"], equals: environment },
        startedAt: { gte: since },
      },
      _max: { startedAt: true },
    });
    // An idle skip is a run that found no work, so it ends a failure streak.
    const { readIdleCompletions, newerOf } =
      await import("@/lib/cron/idle-skips");
    const idle = await readIdleCompletions(prisma, environment, since);
    const report: StreakReport = {};
    for (const [target, jobName] of jobByTarget) {
      const entry: StreakReport[string] = {
        lastCompletedAt: null,
        lastFailedAt: null,
        seenRecently: false,
      };
      let completed: Date | null = null;
      for (const row of rows) {
        if (row.jobName !== jobName) continue;
        entry.seenRecently = true;
        if (row.status === "COMPLETED") completed = row._max.startedAt;
        else entry.lastFailedAt = row._max.startedAt?.toISOString() ?? null;
      }
      const skipped = idle.find((i) => i.jobName === jobName)?.endedAt;
      if (skipped) entry.seenRecently = true;
      entry.lastCompletedAt =
        newerOf(completed, skipped)?.toISOString() ?? null;
      report[target] = entry;
    }
    return NextResponse.json(report, { headers: HEADERS });
  } catch {
    return NextResponse.json(
      { error: "JOB_HISTORY_UNAVAILABLE" },
      { status: 503, headers: HEADERS },
    );
  }
}
