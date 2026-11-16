/**
 * POST /api/admin/system-jobs/run — the admin Run door for every registered
 * cleanup job. It runs the registry's own handler in-process, inside an admin
 * run context, so a manual run and a ticker run share one implementation and
 * one execution trail. No CRON_SECRET reaches the browser. Off production the
 * route refuses every job (409 `JOB_RUN_PRODUCTION_ONLY`); the database is shared.
 * A `manualRun: "after"` job is persisted as an `AdminRunRequest` before its 202.
 */

import { randomUUID } from "node:crypto";
import type { AdminRunRequest } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { opsReasonSchema } from "@/lib/backoffice/ops-reason";
import { reportSentryError } from "@/lib/observability/report";
import { scheduleAfter } from "@/lib/api/after-safe";
import { getMaintenanceState } from "@/lib/maintenance-edge";
import { FINANCIAL_JOB_NAMES } from "@/lib/cron/financial-jobs";
import {
  CLEANUP_JOB_BUILDERS,
  getCleanupJobHandlers,
} from "@/lib/cron/cleanup-registry";
import { jobsMayRunHere } from "@/lib/cron/dispatch-refusal";
import { runOutcomeSchema } from "@/lib/cron/run-outcome";
import {
  auditStatusOf,
  manualRunRequest,
  openAdminRunWhere,
  runAdminRunRequest,
  type AdminRunAuditStatus,
} from "@/lib/cron/admin-run-requests";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { withRunContext } from "@/lib/cron/run-context";
import { isWindowedTarget, latestWindowStart } from "@/lib/cron/schedule";

const runJobSchema = z.object({
  jobId: z.string().min(1, "Missing or invalid jobId"),
  // Every manual run carries a reason into the audit log.
  reason: opsReasonSchema,
  // One per click, reused by its retries; absent from an older client, so the server mints one.
  idempotencyKey: z.string().uuid().optional(),
});

const bodySchema = z.record(z.string(), z.unknown()).catch({});

/** The window a manual run repeats: the latest due one for a windowed job, none otherwise. */
function manualRunWindow(slug: string, now: Date): Date | null | undefined {
  return isWindowedTarget(slug) ? latestWindowStart(slug, now) : undefined;
}

/**
 * Persists the request and its audit row in one transaction before any dispatch.
 * A retry of the same click returns its request in any status; otherwise the job's open request.
 */
async function admitRunRequest(input: {
  job: string;
  idempotencyKey: string;
  actorUserId: string;
  actorRole: string;
  reason: string;
  windowStart: Date | null;
}): Promise<{ request: AdminRunRequest; created: boolean }> {
  const id = randomUUID();
  try {
    const request = await prisma.$transaction(async (tx) => {
      const row = await tx.adminRunRequest.create({
        data: {
          id,
          job: input.job,
          idempotencyKey: input.idempotencyKey,
          requestedBy: input.actorUserId,
          windowStart: input.windowStart,
        },
      });
      await recordOpsAction(tx, {
        id,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        surface: "systemJobs.manage",
        action: "system-job.run",
        targetKind: "SystemJob",
        targetId: input.job,
        reason: input.reason,
        after: { status: "REQUESTED", requestId: id },
      });
      return row;
    });
    return { request, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing =
      (await prisma.adminRunRequest.findUnique({
        where: {
          job_idempotencyKey: {
            job: input.job,
            idempotencyKey: input.idempotencyKey,
          },
        },
      })) ??
      (await prisma.adminRunRequest.findFirst({
        where: openAdminRunWhere(input.job),
      }));
    if (!existing) throw error;
    return { request: existing, created: false };
  }
}

/** The audit status follows the outcome the run row recorded, so a 207 with failed items is PARTIAL. */
function runStatusOf(res: NextResponse): AdminRunAuditStatus {
  if (res.status === 202) return "ACCEPTED";
  const parsed = runOutcomeSchema.safeParse(res.headers.get("x-run-outcome"));
  return auditStatusOf(parsed.success ? parsed.data : null);
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
    const idempotencyKey = parsed.data.idempotencyKey ?? randomUUID();

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

    // Where jobs may run, checking maintenance first keeps a deferred payout run from a silent refusal;
    // elsewhere the handler answers its 409 production-only refusal instead.
    const mayRun = jobsMayRunHere();
    const maintenanceState = mayRun ? await getMaintenanceState() : null;
    if (
      maintenanceState?.phase === "DEGRADED" &&
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
    if (maintenanceState?.phase === "OFFLINE") {
      return NextResponse.json(
        {
          error: `All system jobs are blocked during OFFLINE maintenance. End maintenance mode first.`,
          phase: "OFFLINE",
        },
        { status: 503 },
      );
    }

    const windowStart = manualRunWindow(jobId, new Date());
    if (windowStart === null) {
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

    // A run that outlives the edge timeout is persisted before the 202 and dispatched after it;
    // the drain-admin-run-requests ticker job retries a dispatch that never claimed it.
    if (entry.meta.manualRun === "after" && mayRun) {
      const { request, created } = await admitRunRequest({
        job: jobId,
        idempotencyKey,
        actorUserId: user.id,
        actorRole: String(user.role ?? "UNKNOWN"),
        reason,
        windowStart: windowStart ?? null,
      });
      if (created) {
        // scheduleAfter never rejects: it reports a failed dispatch, and the committed row waits for the drain.
        void scheduleAfter(
          () => runAdminRunRequest(request),
          "admin.system-job.dispatch",
        );
      }
      return NextResponse.json(
        {
          success: true,
          accepted: true,
          dispatched: true,
          requestId: request.id,
          status: request.status,
          existing: !created,
          message: created
            ? "Queued. The request is recorded and its status shows under Run requests."
            : "This run was already requested; its status shows under Run requests.",
        },
        { status: 202 },
      );
    }

    // The audit row's id is fixed up front so the run's execution row can point at it.
    const opsActionLogId = randomUUID();
    const logRun = (status: AdminRunAuditStatus, httpStatus?: number) =>
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
        handlers.invoke(manualRunRequest(jobId, windowStart ?? null)),
      );

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
