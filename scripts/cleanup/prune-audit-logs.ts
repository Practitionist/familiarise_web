/** One bounded slice of the existing seven-/two-year organisation audit policy. */

import prisma from "../../lib/prisma";
import type { OrgAuditCategory, Prisma } from "@prisma/client";
import { z } from "zod";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const KEEP_7Y_CATEGORIES: OrgAuditCategory[] = [
  "INVOICE",
  "PAYOUT",
  "WALLET",
  "CONTRACT",
  "CONSENT",
];

const KEEP_2Y_CATEGORIES: OrgAuditCategory[] = [
  "MEMBER",
  "SETTINGS",
  "CATALOG",
  "SYSTEM",
  "PROGRAM",
  "WEBHOOK",
];

export interface AuditPruneResult {
  scanned: number;
  deleted7y: number;
  deleted2y: number;
  cutoff7y: string;
  cutoff2y: string;
  perOrgSummaries: number;
  success: boolean;
  errors: string[];
  hasMore: boolean;
}

const auditLimit = z.number().int().min(1).max(500).default(100);
const START_BUDGET_MS = 16_000;

export interface AuditPruneOptions {
  limit?: number;
  startedAt?: number;
}

export async function pruneAuditLogs(
  options: AuditPruneOptions = {},
): Promise<AuditPruneResult> {
  const startedAt = options.startedAt ?? Date.now();
  return withCronLock("prune-audit-logs", { failMode: "open" }, () =>
    pruneAuditLogsUnlocked(options.limit, startedAt),
  );
}

async function pruneAuditLogsUnlocked(
  requestedLimit: number | undefined,
  startedAt: number,
): Promise<AuditPruneResult> {
  const limit = auditLimit.parse(requestedLimit);
  const outOfTime = () => Date.now() >= startedAt + START_BUDGET_MS;
  const now = Date.now();
  const cutoff7y = new Date(now - 7 * 365 * 24 * 60 * 60 * 1000);
  const cutoff2y = new Date(now - 2 * 365 * 24 * 60 * 60 * 1000);
  const where: Prisma.OrgAuditLogWhereInput = {
    OR: [
      { category: { in: KEEP_7Y_CATEGORIES }, createdAt: { lt: cutoff7y } },
      { category: { in: KEEP_2Y_CATEGORIES }, createdAt: { lt: cutoff2y } },
    ],
  };
  const result: AuditPruneResult = {
    scanned: 0,
    deleted7y: 0,
    deleted2y: 0,
    cutoff7y: cutoff7y.toISOString(),
    cutoff2y: cutoff2y.toISOString(),
    perOrgSummaries: 0,
    success: true,
    errors: [],
    hasMore: false,
  };
  if (outOfTime()) return { ...result, hasMore: true };

  try {
    const candidates = await prisma.orgAuditLog.findMany({
      where,
      take: limit,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, organizationId: true },
    });
    result.scanned = candidates.length;
    const byOrganization = new Map<string, string[]>();
    for (const row of candidates) {
      const ids = byOrganization.get(row.organizationId) ?? [];
      ids.push(row.id);
      byOrganization.set(row.organizationId, ids);
    }
    for (const [organizationId, ids] of byOrganization) {
      if (outOfTime()) {
        result.hasMore = true;
        break;
      }
      try {
        const committed = await prisma.$transaction(
          async (tx) => {
            const d7 = await tx.orgAuditLog.deleteMany({
              where: {
                id: { in: ids },
                organizationId,
                category: { in: KEEP_7Y_CATEGORIES },
                createdAt: { lt: cutoff7y },
              },
            });
            const d2 = await tx.orgAuditLog.deleteMany({
              where: {
                id: { in: ids },
                organizationId,
                category: { in: KEEP_2Y_CATEGORIES },
                createdAt: { lt: cutoff2y },
              },
            });
            const wroteSummary = d7.count + d2.count > 0;
            if (wroteSummary) {
              await tx.orgAuditLog.create({
                data: {
                  organizationId,
                  category: "SYSTEM",
                  action: AUDIT_ACTIONS.SYSTEM.AUDIT_PRUNED,
                  description: `Pruned ${d7.count + d2.count} audit rows past retention`,
                  details: {
                    deleted7y: d7.count,
                    deleted2y: d2.count,
                    cutoff7y: cutoff7y.toISOString(),
                    cutoff2y: cutoff2y.toISOString(),
                  },
                },
              });
            }
            return { deleted7y: d7.count, deleted2y: d2.count, wroteSummary };
          },
          { maxWait: 1_000, timeout: 8_000 },
        );
        // Count only committed deletes and their atomic summary.
        result.deleted7y += committed.deleted7y;
        result.deleted2y += committed.deleted2y;
        if (committed.wroteSummary) result.perOrgSummaries += 1;
      } catch (error) {
        result.success = false;
        result.hasMore = true;
        result.errors.push(
          `org=${organizationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (outOfTime()) result.hasMore = true;
    else if (
      await prisma.orgAuditLog.findFirst({ where, select: { id: true } })
    )
      result.hasMore = true;
  } catch (error) {
    result.success = false;
    result.hasMore = true;
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
