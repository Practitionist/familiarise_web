import { NextRequest } from "next/server.js";
import type {
  AdminRunRequest,
  AdminRunRequestStatus,
  Prisma,
} from "@prisma/client";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { getCleanupJobHandlers } from "@/lib/cron/cleanup-registry";
import { withRunContext } from "@/lib/cron/run-context";
import { runOutcomeSchema, type RunOutcome } from "@/lib/cron/run-outcome";
import { startDeadline } from "@/lib/cron/run-deadline";
import { scheduleFor } from "@/lib/cron/schedule";
import { withCronLock } from "@/lib/cron/with-cron-lock";

/** A claim beyond this many attempts settles the request FAILED instead. */
export const MAX_ADMIN_RUN_ATTEMPTS = 3;
/** The route's own dispatch claims within this; an older REQUESTED row was lost or released. */
export const LOST_DISPATCH_MS = 2 * 60_000;
/** Past every function ceiling, so a claim this old belongs to a dead invocation. */
export const STALE_CLAIM_MS = 15 * 60_000;
/** Slack for clock skew between the claim and the run row it opened. */
const RUN_LOOKUP_SLACK_MS = 60_000;
const DEFAULT_DRAIN_LIMIT = 2;

const OPEN_STATUSES = ["REQUESTED", "CLAIMED"] as const;

export function openAdminRunWhere(
  job: string,
): Prisma.AdminRunRequestWhereInput {
  return { job, status: { in: [...OPEN_STATUSES] } };
}

export function lostDispatchWhere(now: Date): Prisma.AdminRunRequestWhereInput {
  return {
    status: "REQUESTED",
    updatedAt: { lte: new Date(now.getTime() - LOST_DISPATCH_MS) },
  };
}

export function staleClaimWhere(now: Date): Prisma.AdminRunRequestWhereInput {
  return {
    status: "CLAIMED",
    claimedAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) },
  };
}

export function adminRunBacklogWhere(
  now: Date,
): Prisma.AdminRunRequestWhereInput {
  return { OR: [lostDispatchWhere(now), staleClaimWhere(now)] };
}

/** Ticker idle probe: a drain acts only on a lost dispatch or a stale claim. */
export async function hasAdminRunRequestWork(
  db: Tx,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.adminRunRequest.findFirst({
    where: adminRunBacklogWhere(now),
    select: { id: true },
  });
  return row !== null;
}

/** One bounded slice: the ticker's limit and, for a windowed job, the window fixed at admission. */
export function manualRunRequest(
  job: string,
  windowStart: Date | null,
): NextRequest {
  const url = new URL(`/api/cleanup/${job}`, "https://system-jobs.internal");
  const limit = scheduleFor(job)?.limit;
  if (typeof limit === "number") url.searchParams.set("limit", String(limit));
  if (windowStart) {
    url.searchParams.set("windowStart", windowStart.toISOString());
  }
  return new NextRequest(url, { method: "POST" });
}

export type AdminRunSettlement =
  "DONE" | "FAILED" | "RELEASED" | "LOST_CLAIM" | "LOST_SETTLE";

const RAN_TO_THE_END: ReadonlySet<RunOutcome> = new Set([
  "completed",
  "attention",
  "partial",
]);

/** The `OpsActionLog` `after.status` of an admin run. */
export type AdminRunAuditStatus =
  | "ACCEPTED"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "HELD"
  | "SKIPPED"
  | "REFUSED"
  | "PAUSED";

/** The audit status a recorded run outcome maps to; no outcome is FAILED. */
export function auditStatusOf(outcome: RunOutcome | null): AdminRunAuditStatus {
  switch (outcome) {
    case "completed":
    case "attention":
      return "SUCCEEDED";
    case "partial":
      return "PARTIAL";
    case "held":
      return "HELD";
    case "skipped":
      return "SKIPPED";
    case "refused":
      return "REFUSED";
    case "paused":
      return "PAUSED";
    default:
      return "FAILED";
  }
}

/**
 * Applies a fenced status write and, when it settles the request, moves its audit
 * row (same id) to the run's outcome in the same transaction.
 */
function writeSettlement(
  where: Prisma.AdminRunRequestWhereInput,
  id: string,
  data: Prisma.AdminRunRequestUpdateManyMutationInput & {
    status: AdminRunRequestStatus;
  },
  outcome: RunOutcome | null,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const written = await tx.adminRunRequest.updateMany({ where, data });
    if (written.count === 0) return false;
    if (data.status === "DONE" || data.status === "FAILED") {
      await tx.opsActionLog.updateMany({
        where: { id },
        data: { after: { status: auditStatusOf(outcome), requestId: id } },
      });
    }
    return true;
  });
}

/**
 * Settles the claim `attempt` of a request from its run's outcome. A run that
 * reached the job is DONE or FAILED; a stand-down or a missing outcome goes back
 * to REQUESTED for the drain until the attempts are spent.
 */
async function settle(
  id: string,
  attempt: number,
  outcome: RunOutcome | null,
  runId: string | null,
  detail: string,
): Promise<AdminRunSettlement> {
  let status: AdminRunRequestStatus;
  if (outcome && RAN_TO_THE_END.has(outcome)) status = "DONE";
  else if (outcome === "failed" || attempt >= MAX_ADMIN_RUN_ATTEMPTS)
    status = "FAILED";
  else status = "REQUESTED";
  const written = await writeSettlement(
    { id, status: "CLAIMED", attempts: attempt },
    id,
    {
      status,
      runId,
      // A partial run keeps its marker, so the console does not show a clean DONE.
      lastError: status === "DONE" && outcome !== "partial" ? null : detail,
      ...(status === "REQUESTED" ? {} : { finishedAt: new Date() }),
    },
    outcome,
  );
  if (!written) return "LOST_SETTLE";
  return status === "REQUESTED" ? "RELEASED" : status;
}

const runResultSchema = z.object({ outcome: runOutcomeSchema });

/** The finished run row an attempt opened, found by the request id every run of it records. */
async function finishedRunOf(
  requestId: string,
  claimedAt: Date,
): Promise<{ id: string; outcome: RunOutcome | null } | null> {
  const since = new Date(claimedAt.getTime() - RUN_LOOKUP_SLACK_MS);
  const run = await prisma.systemJobExecution.findFirst({
    where: {
      startedAt: { gte: since },
      createdAt: { gte: since },
      status: { not: "RUNNING" },
      result: { path: ["opsActionLogId"], equals: requestId },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, result: true },
  });
  if (!run) return null;
  const parsed = runResultSchema.safeParse(run.result);
  return { id: run.id, outcome: parsed.success ? parsed.data.outcome : null };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Claims the request by CAS on its status and attempt count (plus `eligible`),
 * commits the claim, then runs the job in-process as the requesting admin.
 */
export async function runAdminRunRequest(
  request: AdminRunRequest,
  eligible: Prisma.AdminRunRequestWhereInput = {},
): Promise<AdminRunSettlement> {
  const claimedAt = new Date();
  const attempt = request.attempts + 1;
  const claimed = await prisma.adminRunRequest.updateMany({
    where: {
      AND: [
        { id: request.id, status: request.status, attempts: request.attempts },
        eligible,
      ],
    },
    data: { status: "CLAIMED", attempts: attempt, claimedAt },
  });
  if (claimed.count === 0) return "LOST_CLAIM";

  const handlers = getCleanupJobHandlers(request.job);
  if (!handlers) {
    return settle(request.id, attempt, "failed", null, "Unknown job");
  }
  let outcome: RunOutcome | null = null;
  let detail: string;
  try {
    const res = await withRunContext(
      {
        triggeredBy: `admin:${request.requestedBy}`,
        opsActionLogId: request.id,
      },
      () => handlers.invoke(manualRunRequest(request.job, request.windowStart)),
    );
    const parsed = runOutcomeSchema.safeParse(res.headers.get("x-run-outcome"));
    outcome = parsed.success ? parsed.data : null;
    detail = `Run ${outcome ?? "recorded no outcome"} (HTTP ${res.status})`;
  } catch (error) {
    detail = errorText(error);
  }
  const run = await finishedRunOf(request.id, claimedAt).catch(() => null);
  return settle(request.id, attempt, outcome, run?.id ?? null, detail);
}

/** A stale claim whose run finished settles from that run; otherwise it is claimed again or failed at the cap. */
async function recoverAdminRunRequest(
  request: AdminRunRequest,
  now: Date,
): Promise<AdminRunSettlement> {
  if (request.status === "CLAIMED" && request.claimedAt) {
    const run = await finishedRunOf(request.id, request.claimedAt);
    if (run) {
      return settle(
        request.id,
        request.attempts,
        run.outcome,
        run.id,
        `Run ${run.outcome ?? "recorded no outcome"}`,
      );
    }
  }
  if (request.attempts >= MAX_ADMIN_RUN_ATTEMPTS) {
    const failed = await writeSettlement(
      {
        AND: [
          {
            id: request.id,
            status: request.status,
            attempts: request.attempts,
          },
          adminRunBacklogWhere(now),
        ],
      },
      request.id,
      {
        status: "FAILED",
        finishedAt: now,
        lastError:
          request.lastError ??
          `No run outcome after ${MAX_ADMIN_RUN_ATTEMPTS} attempts`,
      },
      null,
    );
    return failed ? "FAILED" : "LOST_CLAIM";
  }
  return runAdminRunRequest(request, adminRunBacklogWhere(now));
}

export interface AdminRunDrainResult {
  success: true;
  picked: number;
  done: number;
  settledFailed: number;
  released: number;
  lost: number;
  hasMore: boolean;
}

/** Backstop for the admin Run door: retries lost dispatches and crashed claims, oldest first. */
export async function drainAdminRunRequests(
  opts: { limit?: number; startedAt?: number } = {},
): Promise<AdminRunDrainResult> {
  const limit = opts.limit ?? DEFAULT_DRAIN_LIMIT;
  const outOfTime = startDeadline(opts.startedAt);
  return withCronLock(
    "drain-admin-run-requests",
    { failMode: "closed" },
    async () => {
      const now = new Date();
      const rows = await prisma.adminRunRequest.findMany({
        where: adminRunBacklogWhere(now),
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      });
      const result: AdminRunDrainResult = {
        success: true,
        picked: 0,
        done: 0,
        settledFailed: 0,
        released: 0,
        lost: 0,
        hasMore: rows.length > limit,
      };
      for (const row of rows.slice(0, limit)) {
        if (outOfTime()) {
          result.hasMore = true;
          break;
        }
        result.picked += 1;
        const settled = await recoverAdminRunRequest(row, now);
        if (settled === "DONE") result.done += 1;
        else if (settled === "FAILED") result.settledFailed += 1;
        else if (settled === "RELEASED") result.released += 1;
        else result.lost += 1;
      }
      return result;
    },
  );
}
