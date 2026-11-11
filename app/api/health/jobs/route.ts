import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bearerMatches } from "@/lib/cron/cleanup-route";
import {
  assessOperationalCompletions,
  OPERATIONAL_COMPLETION_REQUIREMENTS,
} from "@/lib/cron/operational-health";
import {
  OPS_DIGEST_JOB,
  opsDigestRunResultSchema,
} from "@/lib/observability/ops-digest-summary";
import { collectionsAreLive } from "@/lib/payments/core/razorpay-key-mode";
import type { Db } from "@/lib/prisma";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store", Vary: "Authorization" };
const skipResultSchema = z.object({ reason: z.string() });
const DAY_MS = 24 * 60 * 60 * 1000;
/** After launch, a paging job skipping for a missing setting this long pages. */
const STANDING_SKIP_PAGE_MS = 7 * DAY_MS;

/**
 * Verdicts the daily digest stored on its newest completed run row, judged now:
 * one indexed read, so a poll never recomputes them.
 */
async function readDigestVerdicts(db: Db, environment: string, now: Date) {
  const row = await db.systemJobExecution.findFirst({
    where: {
      jobName: OPS_DIGEST_JOB,
      status: "COMPLETED",
      result: { path: ["environment"], equals: environment },
    },
    orderBy: { startedAt: "desc" },
    select: { result: true },
  });
  const summary = opsDigestRunResultSchema.safeParse(row?.result).data?.summary;
  const standingConfigSkips = collectionsAreLive()
    ? (summary?.standingSkips ?? []).filter(
        (skip) =>
          skip.tier === "paging" &&
          now.getTime() - Date.parse(skip.firstSeenAt) > STANDING_SKIP_PAGE_MS,
      )
    : [];
  const releaseLag = summary?.releaseLag ?? null;
  return {
    reasons: [
      ...(standingConfigSkips.length > 0 ? ["STANDING_CONFIG_SKIP"] : []),
      ...(releaseLag?.overdue ? ["RELEASE_LAG_OVERDUE"] : []),
    ],
    standingConfigSkips,
    releaseLag,
  };
}

/** Read-only external absence probe; never invokes or repairs a job. */
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
      { healthy: false, error: "JOB_ENVIRONMENT_UNCONFIGURED" },
      { status: 503, headers: HEADERS },
    );
  }
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const { configSkipWhere, readCompletionEvidence } =
      await import("@/lib/cron/completion-evidence");
    const now = new Date();
    const paging = OPERATIONAL_COMPLETION_REQUIREMENTS.filter(
      (job) => job.tier === "paging",
    );
    // Watched jobs belong to the console and the digest.
    const evidence = await readCompletionEvidence(
      prisma,
      environment,
      paging,
      now,
    );
    const report = assessOperationalCompletions({
      ...evidence,
      now,
      tier: "paging",
    });
    // The last day's config-skip reasons, listed for operators.
    const skips = await prisma.systemJobExecution
      .findMany({
        where: {
          ...configSkipWhere(environment),
          createdAt: { gte: new Date(now.getTime() - 26 * 60 * 60 * 1000) },
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
    const digest = await readDigestVerdicts(prisma, environment, now);
    const healthy = report.healthy && digest.reasons.length === 0;
    return NextResponse.json(
      {
        ...report,
        healthy,
        reasons: [
          ...(report.healthy ? [] : ["JOB_OVERDUE"]),
          ...digest.reasons,
        ],
        configSkips,
        standingConfigSkips: digest.standingConfigSkips,
        releaseLag: digest.releaseLag,
        buildSha: process.env.BUILD_SHA ?? null,
      },
      {
        status: healthy ? 200 : 503,
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
