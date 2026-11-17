import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { istDayStart } from "@/lib/compliance/ist-period";
import { isDateOnlySince, type OpsLogFilters } from "@/schemas/ops-log";
import type { OpsLogPage } from "./ops-log-types";
import { resolveTargets, targetKey } from "./target-refs";

export const OPS_LOG_PAGE_SIZE = 50;

/** A date-only `since` starts at IST midnight, like every other money-area day. */
function sinceInstant(since: string): Date {
  // UTC midnight of the date falls at 05:30 IST on that same date.
  return isDateOnlySince(since)
    ? istDayStart(new Date(since))
    : new Date(since);
}

/**
 * #1771 K-9 — one page of OpsActionLog, newest first. A STAFF viewer reads
 * only their own rows whatever filter they send; an ADMIN reads every row.
 */
export async function readOpsLog(args: {
  viewer: { userId: string; role: string };
  filters: OpsLogFilters;
  page: number;
}): Promise<OpsLogPage> {
  const f = args.filters;
  const actorUserId =
    args.viewer.role === "ADMIN" ? f.actorUserId : args.viewer.userId;
  const where: Prisma.OpsActionLogWhereInput = {
    ...(actorUserId ? { actorUserId } : {}),
    ...(f.surface ? { surface: f.surface } : {}),
    ...(f.targetKind ? { targetKind: f.targetKind } : {}),
    ...(f.targetId ? { targetId: f.targetId } : {}),
    ...(f.action ? { action: f.action } : {}),
    ...(f.since ? { createdAt: { gte: sinceInstant(f.since) } } : {}),
  };
  const page = Math.max(1, Math.floor(args.page) || 1);
  const [rows, total] = await Promise.all([
    prisma.opsActionLog.findMany({
      relationLoadStrategy: "join",
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * OPS_LOG_PAGE_SIZE,
      take: OPS_LOG_PAGE_SIZE,
      include: { actor: { select: { name: true } } },
    }),
    prisma.opsActionLog.count({ where }),
  ]);
  const targets = await resolveTargets(
    rows.map((r) => ({ kind: r.targetKind, id: r.targetId })),
  );
  return {
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      actorUserId: r.actorUserId,
      actorName: r.actor?.name ?? null,
      actorRole: r.actorRole,
      surface: r.surface,
      action: r.action,
      targetKind: r.targetKind,
      targetId: r.targetId,
      target: targets.get(targetKey(r.targetKind, r.targetId)) ?? null,
      reason: r.reason,
      before: r.before,
      after: r.after,
    })),
    total,
    page,
    pageSize: OPS_LOG_PAGE_SIZE,
    fetchedAt: new Date().toISOString(),
  };
}
