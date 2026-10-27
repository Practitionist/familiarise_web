/**
 * POST /api/admin/system-jobs/run — the admin Run door for every registered
 * cleanup job. It runs the registry's own handler in-process, inside an admin
 * run context, so a manual run and a ticker run share one implementation and
 * one execution trail. No CRON_SECRET reaches the browser.
 */

import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import {
  opsReasonSchema,
  recordOpsAction,
} from "@/lib/backoffice/ops-action-log";
import { reportSentryError } from "@/lib/observability/report";
import { scheduleAfter } from "@/lib/api/after-safe";
import { getMaintenanceState } from "@/lib/maintenance-edge";
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";
import {
  CLEANUP_JOB_BUILDERS,
  getCleanupJobHandlers,
} from "@/lib/cron/cleanup-registry";
import { runOutcomeSchema } from "@/lib/cron/run-outcome";
import { withRunContext } from "@/lib/cron/run-context";
import {
  isWindowedTarget,
  latestWindowStart,
  scheduleFor,
} from "@/lib/cron/schedule";

const runJobSchema = z.object({
  jobId: z.string().min(1, "Missing or invalid jobId"),
  // Every manual run carries a reason into the audit log.
  reason: opsReasonSchema,
});

const bodySchema = z.record(z.string(), z.unknown()).catch({});

type RunStatus =
  | "ACCEPTED"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "HELD"
  | "SKIPPED"
  | "REFUSED"
  | "PAUSED";

/**
 * One bounded slice: the ticker's own limit and, for a calendar-windowed job,
 * the latest due window, so a manual run repeats that window's slice instead of
 * opening an off-cycle one. Null when a windowed job has had no window yet.
 */
function manualRunRequest(slug: string, now: Date): NextRequest | null {
  const url = new URL(`/api/cleanup/${slug}`, "https://system-jobs.internal");
  const limit = scheduleFor(slug)?.limit;
  if (typeof limit === "number") url.searchParams.set("limit", String(limit));
  if (isWindowedTarget(slug)) {
    const windowStart = latestWindowStart(slug, now);
    if (!windowStart) return null;
    url.searchParams.set("windowStart", windowStart.toISOString());
  }
  return new NextRequest(url, { method: "POST" });
}

/** The audit status follows the outcome the run row recorded, so a 207 with failed items is PARTIAL. */
function runStatusOf(res: NextResponse): RunStatus {
  if (res.status === 202) return "ACCEPTED";
  const parsed = runOutcomeSchema.safeParse(res.headers.get("x-run-outcome"));
  if (!parsed.success) return "FAILED";
  switch (parsed.data) {
    case "completed":
    case "attention":
      return "SUCCEEDED";
    case "partial":
      return "PARTIAL";
    case "failed":
      return "FAILED";
    case "held":
      return "HELD";
    case "skipped":
      return "SKIPPED";
    case "refused":
      return "REFUSED";
    case "paused":
      return "PAUSED";
  }
}

/** Hands the recorded run outcome to the console so it can name it. */
function outcomeHeaders(res: NextResponse): Record<string, string> {
  const outcome = res.headers.get("x-run-outcome");
  return outcome ? { "X-Run-Outcome": outcome } : {};
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireBackofficeSurface("systemJobs.manage");
    if (auth.error) return auth.error;
    const user = auth.session.user;

    const parsed = runJobSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }
    const { jobId, reason } = parsed.data;

    const entry = Object.hasOwn(CLEANUP_JOB_BUILDERS, jobId)
      ? CLEANUP_JOB_BUILDERS[jobId]
      : undefined;
    const handlers = entry ? getCleanupJobHandlers(jobId) : null;
    if (!entry || !handlers) {
      return NextResponse.json(
        { error: `Unknown job ID: ${jobId}` },
        { status: 400 },
      );
    }

    // The route's own gate refuses too; checking first keeps a deferred payout run from a silent refusal.
    const maintenanceState = await getMaintenanceState();
    if (
      maintenanceState.phase === "DEGRADED" &&
      FINANCIAL_JOB_NAMES.has(handlers.job)
    ) {
      return NextResponse.json(
        {
          error: `Job "${jobId}" is blocked during DEGRADED maintenance to protect payment integrity. End maintenance mode first.`,
          phase: "DEGRADED",
        },
        { status: 503 },
      );
    }
    if (maintenanceState.phase === "OFFLINE") {
      return NextResponse.json(
        {
          error: `All system jobs are blocked during OFFLINE maintenance. End maintenance mode first.`,
          phase: "OFFLINE",
        },
        { status: 503 },
      );
    }

    const runRequest = manualRunRequest(jobId, new Date());
    if (!runRequest) {
      return NextResponse.json(
        {
          error: `Job "${jobId}" has had no calendar window yet, so there is no slice to repeat.`,
          code: "NO_DUE_WINDOW",
        },
        { status: 409 },
      );
    }

    console.log(
      `[System Jobs] ${user.name || user.email} (${user.role}) running job: ${jobId}`,
    );

    // The audit row's id is fixed up front so the run's execution row can point at it.
    const opsActionLogId = randomUUID();
    const logRun = (status: RunStatus, httpStatus?: number) =>
      recordOpsAction(prisma, {
        id: opsActionLogId,
        actorUserId: user.id,
        actorRole: String(user.role ?? "UNKNOWN"),
        surface: "systemJobs.manage",
        action: "system-job.run",
        targetKind: "SystemJob",
        targetId: jobId,
        reason,
        after: httpStatus === undefined ? { status } : { status, httpStatus },
      }).catch((logErr: unknown) =>
        reportSentryError(logErr, { subsystem: "admin", op: "ops-log" }),
      );
    const run = () =>
      withRunContext({ triggeredBy: `admin:${user.id}`, opsActionLogId }, () =>
        handlers.invoke(runRequest),
      );

    // A payout run makes a gateway call per row and would meet the edge timeout inside the request.
    if (entry.meta.manualRun === "after") {
      scheduleAfter(async () => {
        try {
          const res = await run();
          await logRun(runStatusOf(res), res.status);
        } catch (err) {
          await logRun("FAILED");
          reportSentryError(err, {
            subsystem: "admin",
            op: "system-job",
            extra: { jobId },
          });
        }
      }, "admin.system-job.dispatch");
      return NextResponse.json(
        {
          success: true,
          dispatched: true,
          message:
            "Started in the background. The outcome is recorded in the ops log.",
        },
        { status: 202 },
      );
    }

    let res: NextResponse;
    try {
      res = await run();
    } catch (err) {
      await logRun("FAILED");
      throw err;
    }
    await logRun(runStatusOf(res), res.status);
    const body = bodySchema.parse(await res.json().catch(() => ({})));
    if (res.status === 202) {
      return NextResponse.json(
        {
          ...body,
          dispatched: true,
          message:
            "Queued for processing. Check execution history for completion.",
        },
        { status: 202, headers: outcomeHeaders(res) },
      );
    }
    return NextResponse.json(body, {
      status: res.status,
      headers: outcomeHeaders(res),
    });
  } catch (error) {
    const runtimeError =
      error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(runtimeError, { tags: { subsystem: "admin" } });
    console.error("[System Jobs] Error running job:", error);
    return NextResponse.json({ error: "Failed to run job" }, { status: 500 });
  }
}
