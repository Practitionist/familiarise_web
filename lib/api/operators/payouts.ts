/**
 * Shared operator payout listing.
 *
 * Used by both `app/api/admin/payouts/route.ts` (GET) and
 * `app/api/staff/payouts/route.ts` (GET) — extracted to remove the
 * near-duplicated query/response shape between the two routes.
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
  search?: string | null;
  limit?: number;
  offset?: number;
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

export async function getOperatorPayouts(
  filters: OperatorPayoutFilters = {},
): Promise<OperatorPayoutResult> {
  const status = filters.status ?? null;
  const search = filters.search ?? null;
  const limit = sanitizePagination(filters.limit, 50, 1, 200);
  const offset = sanitizePagination(filters.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const where: Prisma.PayoutWhereInput = {};
  if (status) {
    where.status = status;
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

  const [payouts, total, stats] = await Promise.all([
    prisma.payout.findMany({
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
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.payout.count({ where }),
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
      earningsCount: p.earnings.length,
      approvedAt: p.approvedAt,
      approvedBy: p.approvedBy,
      processedAt: p.processedAt,
      failureReason: p.failureReason,
      createdAt: p.createdAt,
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
