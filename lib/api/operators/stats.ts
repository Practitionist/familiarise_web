/**
 * Shared operator dashboard statistics.
 *
 * The operator home's totals, read by `app/api/admin/stats/route.ts`.
 *
 * Future work (see `docs/enterprise/00-foundations/01-overview.md` follow-ups):
 * extract similar shared functions for payments listing, invoice listing,
 * verification queue, etc. The pattern is:
 *   1. Put the query/aggregation in `lib/api/operators/<resource>.ts`.
 *   2. Keep the route files as 5-10 line shells that call the shared util.
 *   3. Any role-based scoping lives in the route handler, not the util.
 */

import prisma from "@/lib/prisma";
import { PaymentStatus, RefundStatus } from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";
import { OPEN_DISPUTE_WHERE } from "@/lib/backoffice/queue-predicates";

const PAYMENT_TILE_STATUSES: PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.PENDING,
  PaymentStatus.EXPIRED,
];

export type OperatorDashboardStats = {
  totalPayments: number;
  totalPaymentsValue: number;
  pendingPayments: number;
  pendingPaymentsValue: number;
  expiredPayments: number;
  totalRefunds: number;
  totalRefundsValue: number;
  activeDisputes: number;
  totalDisputes: number;
  recentPayments: Awaited<ReturnType<typeof fetchRecentPayments>>;
  recentRefunds: Awaited<ReturnType<typeof fetchRecentRefunds>>;
  gatewayStats: Record<string, { count: number }>;
};

function fetchRecentPayments() {
  return prisma.payment.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      createdAt: true,
      appointment: {
        select: { appointmentType: true },
      },
    },
  });
}

function fetchRecentRefunds() {
  return prisma.refund.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amountPaise: true,
      currency: true,
      status: true,
      paymentGateway: true,
      createdAt: true,
    },
  });
}

/**
 * Fetch the full operator dashboard stats payload.
 *
 * This is the single source of truth — call it from any role-scoped
 * dashboard route (admin, staff) after your auth helper has run. Do not
 * re-implement these queries inside individual route files.
 */
export async function getOperatorDashboardStats(): Promise<OperatorDashboardStats> {
  const [
    paymentTiles,
    refundTile,
    activeDisputes,
    totalDisputes,
    recentPayments,
    recentRefunds,
    gatewayStats,
  ] = await Promise.all([
    // One statement per tile set, so a tile's count and value share one snapshot.
    prisma.payment.groupBy({
      by: ["paymentStatus"],
      where: { paymentStatus: { in: PAYMENT_TILE_STATUSES } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.refund.aggregate({
      where: { status: RefundStatus.SUCCEEDED },
      _count: { _all: true },
      _sum: { amountPaise: true },
    }),
    prisma.dispute.count({ where: OPEN_DISPUTE_WHERE }),
    prisma.dispute.count(),
    fetchRecentPayments(),
    fetchRecentRefunds(),
    prisma.payment.groupBy({
      by: ["paymentGateway"],
      _count: true,
    }),
  ]);

  const tile = (status: PaymentStatus) => {
    const row = paymentTiles.find((r) => r.paymentStatus === status);
    return { count: row?._count._all ?? 0, value: sumPaise(row?._sum.amount) };
  };
  const succeeded = tile(PaymentStatus.SUCCEEDED);
  const pending = tile(PaymentStatus.PENDING);

  const formattedGatewayStats = gatewayStats.reduce(
    (acc, stat) => {
      acc[stat.paymentGateway] = { count: stat._count };
      return acc;
    },
    {} as Record<string, { count: number }>,
  );

  return {
    totalPayments: succeeded.count,
    totalPaymentsValue: succeeded.value,
    pendingPayments: pending.count,
    pendingPaymentsValue: pending.value,
    expiredPayments: tile(PaymentStatus.EXPIRED).count,
    totalRefunds: refundTile._count._all,
    totalRefundsValue: sumPaise(refundTile._sum.amountPaise),
    activeDisputes,
    totalDisputes,
    recentPayments,
    recentRefunds,
    gatewayStats: formattedGatewayStats,
  };
}
