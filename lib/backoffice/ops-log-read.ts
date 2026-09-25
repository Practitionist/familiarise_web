import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import type { OpsLogFilters, OpsLogPage } from "./ops-log-types";

export const OPS_LOG_PAGE_SIZE = 50;

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
  };
  const page = Math.max(1, Math.floor(args.page) || 1);
  const [rows, total] = await Promise.all([
    prisma.opsActionLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * OPS_LOG_PAGE_SIZE,
      take: OPS_LOG_PAGE_SIZE,
      include: { actor: { select: { name: true } } },
    }),
    prisma.opsActionLog.count({ where }),
  ]);
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
      reason: r.reason,
      before: r.before,
      after: r.after,
    })),
    total,
    page,
    pageSize: OPS_LOG_PAGE_SIZE,
  };
}

/** The filters a query string carries, blanks dropped. */
export function opsLogFiltersFrom(
  get: (key: string) => string | null | undefined,
): OpsLogFilters {
  const pick = (k: string) => get(k)?.trim() || undefined;
  return {
    actorUserId: pick("actorUserId"),
    surface: pick("surface"),
    targetKind: pick("targetKind"),
    targetId: pick("targetId"),
  };
}
