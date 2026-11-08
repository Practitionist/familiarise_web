/** One bounded slice of the audit-class retention windows in docs/decisions/2026-11-01-data-retention-windows.md. */

import prisma from "../../lib/prisma";
import type {
  AppointmentStatus,
  ClassStatus,
  OrgAuditCategory,
  Prisma,
  TrialStatus,
  WebinarStatus,
} from "@prisma/client";
import { z } from "zod";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import type { BackofficeSurface } from "../../lib/auth/backoffice-permissions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { deleteBoundedPage } from "@/lib/cron/run-deadline";
import { yearsBefore } from "@/lib/cron/retention-cutoff";

const MONEY_AUDIT_YEARS = 8;
const OTHER_AUDIT_YEARS = 2;
const BOOKING_HISTORY_YEARS = 3;
const LEDGER_REPORT_YEARS = 2;

const KEEP_8Y_CATEGORIES: OrgAuditCategory[] = [
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

/** Each console surface's audit window; a row whose surface is not a current key keeps the money window. */
const OPS_SURFACE_WINDOW: Record<BackofficeSurface, "money" | "other"> = {
  "tickets.manage": "other",
  "threads.manage": "other",
  "feedback.manage": "other",
  "moderation.manage": "other",
  "supportChat.read": "other",
  "supportChat.intervene": "other",
  "engineering.escalate": "other",
  "appointments.manage": "other",
  "newsletter.manage": "other",
  "leads.manage": "other",
  "users.read": "other",
  "users.verify": "other",
  "users.moderate": "other",
  "team.read": "other",
  "recordings.read": "other",
  "recordings.play": "other",
  "payments.read": "money",
  "payments.manage": "money",
  "refunds.read": "money",
  "refunds.manage": "money",
  "supportRefunds.executeBounded": "money",
  "supportHolds.manage": "money",
  "appointments.cancelForPlatform": "money",
  "disputes.read": "money",
  "disputes.manage": "money",
  "invoices.read": "money",
  "invoices.manage": "money",
  "subscriptions.read": "money",
  "subscriptions.manage": "money",
  "payouts.read": "money",
  "payouts.manage": "money",
  "referrals.read": "money",
  "referrals.manage": "money",
  "approvalPayments.manage": "money",
  "tds.read": "money",
  "classSeries.support": "other",
  "classSeries.money": "money",
  "incidents.read": "money",
  "incidents.declare": "money",
  "opsLog.read": "other",
  "organizations.manage": "other",
  "announcements.manage": "other",
  "analytics.read": "other",
  "systemJobs.manage": "other",
  "maintenance.manage": "other",
  "videoConfig.manage": "other",
  "compliance.manage": "other",
  "newsletter.send": "other",
};

const OTHER_OPS_SURFACES = Object.entries(OPS_SURFACE_WINDOW).flatMap(
  ([surface, window]) => (window === "other" ? [surface] : []),
);

const TERMINAL_REQUEST: AppointmentStatus[] = [
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
];
const TERMINAL_EVENT: (WebinarStatus & ClassStatus)[] = [
  "COMPLETED",
  "CANCELLED",
];
const TERMINAL_TRIAL: TrialStatus[] = [
  "COMPLETED",
  "CONVERTED",
  "CANCELLED",
  "REJECTED",
];

/**
 * History rows of an appointment whose every parent is terminal and whose last
 * transition and last session ended before `cutoff`. A live booking's rows (the
 * reschedule restore reads its PENDING origin at any age) and unlinked rows are never selected.
 */
function bookingHistoryPruneWhere(
  cutoff: Date,
): Prisma.BookingStatusHistoryWhereInput {
  const ended = { updatedAt: { lt: cutoff } };
  return {
    createdAt: { lt: cutoff },
    appointment: {
      is: {
        ...ended,
        occurrences: { none: { endsAt: { gte: cutoff } } },
        AND: [
          {
            OR: [
              { consultationId: null },
              {
                consultation: {
                  is: { status: { in: TERMINAL_REQUEST }, ...ended },
                },
              },
            ],
          },
          {
            OR: [
              { subscriptionId: null },
              {
                subscription: {
                  is: { status: { in: TERMINAL_REQUEST }, ...ended },
                },
              },
            ],
          },
          {
            OR: [
              { webinarId: null },
              {
                webinar: { is: { status: { in: TERMINAL_EVENT }, ...ended } },
              },
            ],
          },
          {
            OR: [
              { classId: null },
              { class: { is: { status: { in: TERMINAL_EVENT }, ...ended } } },
            ],
          },
          {
            OR: [
              { trial: { is: null } },
              { trial: { is: { status: { in: TERMINAL_TRIAL }, ...ended } } },
            ],
          },
        ],
      },
    },
  };
}

export interface AuditPruneResult {
  scanned: number;
  deleted8y: number;
  deleted2y: number;
  cutoff8y: string;
  cutoff2y: string;
  perOrgSummaries: number;
  opsActionsDeleted8y: number;
  opsActionsDeleted2y: number;
  opsProposalsDeleted: number;
  bookingHistoryDeleted: number;
  ledgerReportsDeleted: number;
  success: boolean;
  errors: string[];
  hasMore: boolean;
}

function formatPruneError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const cutoff8y = yearsBefore(now, MONEY_AUDIT_YEARS);
  const cutoff2y = yearsBefore(now, OTHER_AUDIT_YEARS);
  const result: AuditPruneResult = {
    scanned: 0,
    deleted8y: 0,
    deleted2y: 0,
    cutoff8y: cutoff8y.toISOString(),
    cutoff2y: cutoff2y.toISOString(),
    perOrgSummaries: 0,
    opsActionsDeleted8y: 0,
    opsActionsDeleted2y: 0,
    opsProposalsDeleted: 0,
    bookingHistoryDeleted: 0,
    ledgerReportsDeleted: 0,
    success: true,
    errors: [],
    hasMore: false,
  };
  if (outOfTime()) return { ...result, hasMore: true };

  await pruneOrgAuditSlice(result, limit, outOfTime, cutoff8y, cutoff2y);

  const page = async <W>(
    label: string,
    where: W,
    find: (where: W, take: number) => Promise<{ id: string }[]>,
    remove: (where: W, ids: string[]) => Promise<{ count: number }>,
    probe: (where: W) => Promise<{ id: string } | null>,
  ): Promise<number> => {
    const slice = await deleteBoundedPage({
      outOfTime,
      pick: () => find(where, limit),
      remove: (ids) => remove(where, ids),
      remains: () => probe(where),
      onError: (error) => {
        result.success = false;
        result.errors.push(`${label}: ${formatPruneError(error)}`);
      },
    });
    result.hasMore ||= slice.hasMore;
    return slice.deleted;
  };
  const opsActions = (where: Prisma.OpsActionLogWhereInput) =>
    page(
      "ops action log",
      where,
      (w, take) =>
        prisma.opsActionLog.findMany({
          where: w,
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
        }),
      (w, ids) =>
        prisma.opsActionLog.deleteMany({
          where: { AND: [w, { id: { in: ids } }] },
        }),
      (w) => prisma.opsActionLog.findFirst({ where: w, select: { id: true } }),
    );

  result.opsActionsDeleted8y = await opsActions({
    surface: { notIn: OTHER_OPS_SURFACES },
    createdAt: { lt: cutoff8y },
  });
  result.opsActionsDeleted2y = await opsActions({
    surface: { in: OTHER_OPS_SURFACES },
    createdAt: { lt: cutoff2y },
  });
  // Only second-approver money doors open proposals, so every proposal keeps the money window.
  result.opsProposalsDeleted = await page(
    "ops action proposal",
    {
      createdAt: { lt: cutoff8y },
    } satisfies Prisma.OpsActionProposalWhereInput,
    (w, take) =>
      prisma.opsActionProposal.findMany({
        where: w,
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      }),
    (w, ids) =>
      prisma.opsActionProposal.deleteMany({ where: { ...w, id: { in: ids } } }),
    (w) =>
      prisma.opsActionProposal.findFirst({ where: w, select: { id: true } }),
  );
  result.bookingHistoryDeleted = await page(
    "booking status history",
    bookingHistoryPruneWhere(yearsBefore(now, BOOKING_HISTORY_YEARS)),
    (w, take) =>
      prisma.bookingStatusHistory.findMany({
        where: w,
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      }),
    (w, ids) =>
      prisma.bookingStatusHistory.deleteMany({
        where: { AND: [w, { id: { in: ids } }] },
      }),
    (w) =>
      prisma.bookingStatusHistory.findFirst({ where: w, select: { id: true } }),
  );
  result.ledgerReportsDeleted = await page(
    "ledger reconciliation report",
    {
      runAt: { lt: yearsBefore(now, LEDGER_REPORT_YEARS) },
    } satisfies Prisma.LedgerReconciliationReportWhereInput,
    (w, take) =>
      prisma.ledgerReconciliationReport.findMany({
        where: w,
        select: { id: true },
        orderBy: [{ runAt: "asc" }, { id: "asc" }],
        take,
      }),
    (w, ids) =>
      prisma.ledgerReconciliationReport.deleteMany({
        where: { ...w, id: { in: ids } },
      }),
    (w) =>
      prisma.ledgerReconciliationReport.findFirst({
        where: w,
        select: { id: true },
      }),
  );
  return result;
}

/** Per organisation, the deletes and their summary row commit together. */
async function pruneOrgAuditSlice(
  result: AuditPruneResult,
  limit: number,
  outOfTime: () => boolean,
  cutoff8y: Date,
  cutoff2y: Date,
): Promise<void> {
  const where: Prisma.OrgAuditLogWhereInput = {
    OR: [
      { category: { in: KEEP_8Y_CATEGORIES }, createdAt: { lt: cutoff8y } },
      { category: { in: KEEP_2Y_CATEGORIES }, createdAt: { lt: cutoff2y } },
    ],
  };
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
            const d8 = await tx.orgAuditLog.deleteMany({
              where: {
                id: { in: ids },
                organizationId,
                category: { in: KEEP_8Y_CATEGORIES },
                createdAt: { lt: cutoff8y },
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
            const wroteSummary = d8.count + d2.count > 0;
            if (wroteSummary) {
              await tx.orgAuditLog.create({
                data: {
                  organizationId,
                  category: "SYSTEM",
                  action: AUDIT_ACTIONS.SYSTEM.AUDIT_PRUNED,
                  description: `Pruned ${d8.count + d2.count} audit rows past retention`,
                  details: {
                    deleted8y: d8.count,
                    deleted2y: d2.count,
                    cutoff8y: cutoff8y.toISOString(),
                    cutoff2y: cutoff2y.toISOString(),
                  },
                },
              });
            }
            return { deleted8y: d8.count, deleted2y: d2.count, wroteSummary };
          },
          { maxWait: 1_000, timeout: 8_000 },
        );
        // Count only committed deletes and their atomic summary.
        result.deleted8y += committed.deleted8y;
        result.deleted2y += committed.deleted2y;
        if (committed.wroteSummary) result.perOrgSummaries += 1;
      } catch (error) {
        result.success = false;
        result.hasMore = true;
        result.errors.push(`org=${organizationId}: ${formatPruneError(error)}`);
      }
    }
    if (
      outOfTime() ||
      (await prisma.orgAuditLog.findFirst({ where, select: { id: true } }))
    )
      result.hasMore = true;
  } catch (error) {
    result.success = false;
    result.hasMore = true;
    result.errors.push(formatPruneError(error));
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
