import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/cron/cleanup-route";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "@/lib/cron/operational-health";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", Vary: "Authorization" };

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
    const rows = await prisma.systemJobExecution.groupBy({
      by: ["jobName"],
      where: {
        jobName: {
          in: OPERATIONAL_COMPLETION_REQUIREMENTS.map((job) => job.jobName),
        },
        status: "COMPLETED",
        result: { path: ["environment"], equals: environment },
        startedAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
      },
      _max: { endedAt: true },
    });
    const report = assessOperationalCompletions(
      rows.map((row) => ({ jobName: row.jobName, endedAt: row._max.endedAt })),
      now,
    );
    return NextResponse.json(report, {
      status: report.healthy ? 200 : 503,
      headers: HEADERS,
    });
  } catch {
    return NextResponse.json(
      { healthy: false, error: "JOB_HISTORY_UNAVAILABLE" },
      { status: 503, headers: HEADERS },
    );
  }
}
