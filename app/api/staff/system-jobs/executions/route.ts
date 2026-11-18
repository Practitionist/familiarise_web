/**
 * Staff System Jobs Executions API
 * List job execution history
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { SystemJobStatus, Prisma } from "@prisma/client";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { TICK_CLAIM_JOB } from "@/lib/cron/schedule";
import { metricsEnvironmentSchema } from "@/lib/backoffice/job-run-metrics";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
const ExecutionsQuerySchema = z.object({
  jobId: z.string().min(1).optional(),
  status: z
    .nativeEnum(SystemJobStatus, { message: "Unknown status" })
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  environment: metricsEnvironmentSchema.optional(),
});

/**
 * GET /api/staff/system-jobs/executions
 * List job execution history with filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("systemJobs.manage");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const query = ExecutionsQuerySchema.safeParse(
      Object.fromEntries(searchParams),
    );
    if (!query.success) {
      return NextResponse.json(
        {
          error: query.error.issues[0]?.message ?? "Invalid query",
          code: "INVALID_QUERY",
        },
        { status: 400 },
      );
    }
    const { jobId, status, page, limit } = query.data;
    const offset = (page - 1) * limit;

    const where: Prisma.SystemJobExecutionWhereInput = {};

    if (jobId) {
      where.jobId = jobId;
    } else {
      // The ticker's slot claims are bookkeeping; they are listed only when asked for by name.
      where.jobName = { not: TICK_CLAIM_JOB };
    }
    if (status) {
      where.status = status;
    }
    if (query.data.environment) {
      where.result = { path: ["environment"], equals: query.data.environment };
    }

    const [executions, total] = await Promise.all([
      prisma.systemJobExecution.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.systemJobExecution.count({ where }),
    ]);

    const SYSTEM_TRIGGER_LABELS: Record<string, string> = {
      cron: "System (Cron)",
      "github-actions": "GitHub Actions",
    };

    // An admin run records `admin:<userId>`; older rows hold a bare user id.
    const userIdOf = (triggeredBy: string) =>
      /^admin:(.+)$/.exec(triggeredBy)?.[1] ?? triggeredBy;

    // Get user info for user-triggered executions (excluding system trigger labels)
    const triggeredByIds = executions
      .map((e) => (e.triggeredBy ? userIdOf(e.triggeredBy) : null))
      .filter(
        (id): id is string =>
          typeof id === "string" &&
          id.length > 0 &&
          !(id in SYSTEM_TRIGGER_LABELS),
      );

    const triggeredByUsers =
      triggeredByIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: triggeredByIds } },
            select: { id: true, name: true, email: true },
          })
        : [];

    const userMap = new Map(triggeredByUsers.map((u) => [u.id, u]));

    const formattedExecutions = executions.map((execution) => ({
      id: execution.id,
      jobId: execution.jobId,
      jobName: execution.jobName,
      status: execution.status,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      durationMs: execution.durationMs,
      itemsProcessed: execution.itemsProcessed,
      errorCount: execution.errorCount,
      triggeredBy: execution.triggeredBy
        ? SYSTEM_TRIGGER_LABELS[execution.triggeredBy]
          ? {
              id: execution.triggeredBy,
              name: SYSTEM_TRIGGER_LABELS[execution.triggeredBy],
              email: null,
            }
          : userMap.get(userIdOf(execution.triggeredBy)) || {
              id: execution.triggeredBy,
              name: "Deleted User",
              email: null,
            }
        : null,
      result: execution.result,
      errorLog: execution.errorLog,
    }));

    return NextResponse.json({
      executions: formattedExecutions,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching job executions:", error);
    return NextResponse.json(
      { error: "Failed to fetch job executions" },
      { status: 500 },
    );
  }
}
