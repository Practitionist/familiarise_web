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

/** Read-only: when each requested target's job last COMPLETED, for the ticker's repeat-failure escalation. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
  if (!secret || !bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: HEADERS },
    );
  }
  // Targets whose core writes no execution row are left out: unknown history is a one-off.
  const jobByTarget = new Map<string, string>();
  for (const name of (request.nextUrl.searchParams.get("targets") ?? "")
    .split(",")
    .filter(isTarget)) {
    const jobName = jobNameFor(name);
    if (jobName !== null) jobByTarget.set(name, jobName);
  }
  if (jobByTarget.size === 0) {
    return NextResponse.json({}, { headers: HEADERS });
  }
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const rows = await prisma.systemJobExecution.groupBy({
      by: ["jobName", "status"],
      where: {
        jobName: { in: [...new Set(jobByTarget.values())] },
        status: { in: ["COMPLETED", "FAILED"] },
        startedAt: { gte: new Date(Date.now() - HISTORY_MS) },
      },
      _max: { startedAt: true },
    });
    const report: StreakReport = {};
    for (const [target, jobName] of jobByTarget) {
      const entry: StreakReport[string] = {
        lastCompletedAt: null,
        seenRecently: false,
      };
      for (const row of rows) {
        if (row.jobName !== jobName) continue;
        entry.seenRecently = true;
        if (row.status === "COMPLETED" && row._max.startedAt) {
          entry.lastCompletedAt = row._max.startedAt.toISOString();
        }
      }
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
