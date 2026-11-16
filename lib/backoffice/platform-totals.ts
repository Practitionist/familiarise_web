import { UserRole } from "@prisma/client";

import prisma from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";
import { operatorMonthStart } from "@/lib/time/operator-zone";

export interface PlatformTotals {
  /** 00:00 IST on the first of this India-time month; every "this month" counts from it. */
  monthStartsAt: string;
  users: { total: number; newThisMonth: number };
  experts: { total: number; active: number };
  learners: { total: number; active: number };
  staff: { total: number };
  sessions: {
    total: number;
    completed: number;
    upcoming: number;
    cancelled: number;
  };
  revenue: { totalPaise: number; thisMonthPaise: number };
  refunds: { totalPaise: number };
}

/** Platform-wide people, session and money totals for the Metrics page. */
export async function getPlatformTotals(
  now: Date = new Date(),
): Promise<PlatformTotals> {
  const monthStart = operatorMonthStart(now);
  const [
    totalUsers,
    newUsersThisMonth,
    totalExperts,
    activeExperts,
    totalLearners,
    activeLearners,
    totalStaff,
    totalSessions,
    completedSessions,
    upcomingSessions,
    cancelledSessions,
    revenueTotal,
    revenueThisMonth,
    refundTotal,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.user.count({ where: { role: UserRole.CONSULTANT } }),
    prisma.user.count({
      where: { role: UserRole.CONSULTANT, onboardingCompleted: true },
    }),
    prisma.user.count({ where: { role: UserRole.CONSULTEE } }),
    prisma.user.count({
      where: { role: UserRole.CONSULTEE, onboardingCompleted: true },
    }),
    prisma.user.count({ where: { role: UserRole.STAFF } }),
    prisma.appointment.count(),
    // A booking counts as completed once any of its sessions has ended.
    prisma.appointment.count({
      where: { occurrences: { some: { endsAt: { lt: now } } } },
    }),
    prisma.appointment.count({
      where: { occurrences: { some: { startsAt: { gt: now } } } },
    }),
    prisma.consultation.count({ where: { status: "CANCELLED" } }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: "SUCCEEDED" },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: "SUCCEEDED", createdAt: { gte: monthStart } },
    }),
    prisma.refund.aggregate({
      _sum: { amountPaise: true },
      where: { status: "SUCCEEDED" },
    }),
  ]);

  return {
    monthStartsAt: monthStart.toISOString(),
    users: { total: totalUsers, newThisMonth: newUsersThisMonth },
    experts: { total: totalExperts, active: activeExperts },
    learners: { total: totalLearners, active: activeLearners },
    staff: { total: totalStaff },
    sessions: {
      total: totalSessions,
      completed: completedSessions,
      upcoming: upcomingSessions,
      cancelled: cancelledSessions,
    },
    revenue: {
      totalPaise: sumPaise(revenueTotal._sum.amount),
      thisMonthPaise: sumPaise(revenueThisMonth._sum.amount),
    },
    refunds: { totalPaise: sumPaise(refundTotal._sum?.amountPaise) },
  };
}
