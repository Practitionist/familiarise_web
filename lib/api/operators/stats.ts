/**
 * Shared operator dashboard statistics.
 *
 * Used by both the admin and staff dashboard home screens. Extracted from
 * the previously-duplicated `app/api/admin/stats/route.ts` and
 * `app/api/staff/stats/route.ts` to give a single source of truth and
 * eliminate drift between the two dashboards' numbers.
 *
 * Future work (see `docs/enterprise/00-canonical-design.md` follow-ups):
 * extract similar shared functions for payments listing, invoice listing,
 * verification queue, etc. The pattern is:
 *   1. Put the query/aggregation in `lib/api/operators/<resource>.ts`.
 *   2. Keep the route files as 5-10 line shells that call the shared util.
 *   3. Any role-based scoping lives in the route handler, not the util.
 */

import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";

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
      amount: true,
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
    totalPayments,
    pendingPayments,
    expiredPayments,
    totalRefunds,
    activeDisputes,
    totalDisputes,
    recentPayments,
    recentRefunds,
    paymentsAggregation,
    pendingPaymentsAggregation,
    refundsAggregation,
    gatewayStats,
  ] = await Promise.all([
    prisma.payment.count(),
    prisma.payment.count({ where: { paymentStatus: PaymentStatus.PENDING } }),
    prisma.payment.count({ where: { paymentStatus: PaymentStatus.EXPIRED } }),
    prisma.refund.count(),
    prisma.dispute.count({
      where: {
        status: {
          in: ["WARNING_NEEDS_RESPONSE", "NEEDS_RESPONSE", "UNDER_REVIEW"],
        },
      },
    }),
    prisma.dispute.count(),
    fetchRecentPayments(),
    fetchRecentRefunds(),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: PaymentStatus.SUCCEEDED },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: PaymentStatus.PENDING },
    }),
    prisma.refund.aggregate({ _sum: { amount: true } }),
    prisma.payment.groupBy({
      by: ["paymentGateway"],
      _count: true,
    }),
  ]);

  const formattedGatewayStats = gatewayStats.reduce(
    (acc, stat) => {
      acc[stat.paymentGateway] = { count: stat._count };
      return acc;
    },
    {} as Record<string, { count: number }>,
  );

  return {
    totalPayments,
    totalPaymentsValue: paymentsAggregation._sum.amount ?? 0,
    pendingPayments,
    pendingPaymentsValue: pendingPaymentsAggregation._sum.amount ?? 0,
    expiredPayments,
    totalRefunds,
    totalRefundsValue: refundsAggregation._sum.amount ?? 0,
    activeDisputes,
    totalDisputes,
    recentPayments,
    recentRefunds,
    gatewayStats: formattedGatewayStats,
  };
}
