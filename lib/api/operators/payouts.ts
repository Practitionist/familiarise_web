/**
 * Shared operator payout listing.
 *
 * Used by `app/api/admin/payouts/route.ts` (GET), which both trees read
 * (the staff twin was deleted, #1527).
 *
 * The admin route additionally exposes a POST handler for creating payout
 * batches; that logic stays inline in the admin route file because staff
 * does not have it.
 */

import prisma from "@/lib/prisma";
import {
  PaymentGateway,
  PayoutMethod,
  PayoutStatus,
  Prisma,
} from "@prisma/client";
import { getPayoutStats } from "@/lib/payments/payouts";

export type OperatorPayoutFilters = {
  status?: PayoutStatus | null;
  /** #1527 — any of these statuses; ignored when `status` is set. */
  statusIn?: PayoutStatus[] | null;
  /** #1771 K-4 — 'INSTANT' narrows to above-cap instant payouts (PR-2). */
  kind?: "INSTANT" | null;
  search?: string | null;
  limit?: number;
  offset?: number;
  /**
   * #674 comment 7 — optional org-scope filter. Restricts the consultant
   * payout list to payouts whose underlying ConsultantEarnings rows came
   * from Payments tagged to the given org. Useful for support drilling
   * into "Acme paid these consultants out of pocket".
   *
   * Note: this is the consultant payout surface (`Payout` model). For
   * org-side payouts (`OrganizationPayout`), use the dedicated
   * `/api/organizations/[orgId]/payouts` route.
   */
  orgId?: string | null;
};

export type OperatorPayout = {
  id: string;
  consultantProfileId: string;
  consultantName: string;
  consultantEmail: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  method: PayoutMethod;
  provider: PaymentGateway;
  batchId: string | null;
  kind: string | null;
  earningsCount: number;
  approvedAt: Date | null;
  approvedBy: string | null;
  processedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
};

export type OperatorPayoutResult = {
  payouts: OperatorPayout[];
  stats: Awaited<ReturnType<typeof getPayoutStats>>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

/**
 * Fetch the operator payout list for admin/staff dashboards.
 *
 * Single source of truth — call from any privileged-role route after running
 * `requirePrivilegedAuth()`. Search-by-consultant filter is supported on
 * both surfaces (admin always exposed it; staff did not but the query is
 * harmless when `search` is empty).
 */
/**
 * Clamp and finite-check a pagination value. Guards against `NaN` from
 * `parseInt("abc")` propagating into Prisma `take` / `skip`.
 */
function sanitizePagination(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/**
 * The payout list's `where`. #1527 — also the Payouts nav badge
 * (`{ status: "PENDING" }`, the Awaiting approval tab), so the two agree.
 */
export function payoutListWhere(
  filters: OperatorPayoutFilters,
): Prisma.ConsultantPayoutWhereInput {
  const status = filters.status ?? null;
  const search = filters.search ?? null;
  const orgId = filters.orgId ?? null;
  const where: Prisma.ConsultantPayoutWhereInput = {};
  if (status) {
    where.status = status;
  } else if (filters.statusIn?.length) {
    where.status = { in: filters.statusIn };
  }
  if (filters.kind) {
    where.kind = filters.kind;
  }
  if (search) {
    where.consultantProfile = {
      user: {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ],
      },
    };
  }
  if (orgId) {
    // Filter to payouts whose earnings came from this org's payments.
    where.earnings = {
      some: { payment: { is: { organizationId: orgId } } },
    };
  }

  return where;
}

export async function getOperatorPayouts(
  filters: OperatorPayoutFilters = {},
): Promise<OperatorPayoutResult> {
  const limit = sanitizePagination(filters.limit, 50, 1, 200);
  const offset = sanitizePagination(
    filters.offset,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const where = payoutListWhere(filters);

  const [payouts, total, stats] = await Promise.all([
    prisma.consultantPayout.findMany({
      where,
      include: {
        consultantProfile: {
          include: {
            user: { select: { name: true, email: true } },
          },
        },
        earnings: {
          select: { id: true },
        },
      },
      // #863 — MSME §43B(h): pay micro/small vendors within their statutory
      // window first. Order by mustPayByDate ascending (soonest deadline on top,
      // nulls last), then newest. Gives ops a due-date-first work queue.
      orderBy: [
        { mustPayByDate: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take: limit,
      skip: offset,
    }),
    prisma.consultantPayout.count({ where }),
    getPayoutStats(),
  ]);

  return {
    payouts: payouts.map((p) => ({
      id: p.id,
      consultantProfileId: p.consultantProfileId,
      consultantName: p.consultantProfile.user.name || "Unknown",
      consultantEmail: p.consultantProfile.user.email,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      method: p.method,
      provider: p.provider,
      batchId: p.batchId,
      kind: p.kind,
      earningsCount: p.earnings.length,
      approvedAt: p.approvedAt,
      approvedBy: p.approvedBy,
      processedAt: p.processedAt,
      failureReason: p.failureReason,
      createdAt: p.createdAt,
      // #863 — MSME statutory pay-by date (null for non-MSME vendors).
      mustPayByDate: p.mustPayByDate,
    })),
    stats,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  };
}
