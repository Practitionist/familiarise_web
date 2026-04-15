/**
 * Server-side prefetch helpers for org dashboard pages.
 *
 * These functions run on the server during SSR and are passed to
 * `queryClient.prefetchQuery` inside `HydrationBoundary` wrappers.
 * They bypass auth-gated API routes and query the DB directly via Prisma.
 *
 * Each function swallows errors and returns `null` on failure so that a DB
 * hiccup doesn't crash the page render — the client will re-fetch on mount.
 */

import prisma from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Types (mirroring client-side shapes)
// ---------------------------------------------------------------------------

export interface OrgAnalytics {
  members: { total: number; learners: number };
  plans: { active: number };
  bookings: {
    monthToDate: number;
    lastMonth: number;
    deltaPct: number | null;
  };
  revenue: { monthToDateGross: number };
  seatsTotal: number | null;
  seatsUsed: number;
}

export interface OrgBilling {
  billingMode: string | null;
  currency: string;
  monthToDate: { gross: number; paymentCount: number };
  outstanding: { amount: number; invoiceCount: number };
  pendingCharges: { amount: number; paymentCount: number } | null;
  creditPool: { balance: number; totalPurchased: number } | null;
  orgInvoiceCreditLimit: number | null;
  paymentTermsDays: number;
}

export interface MemberRow {
  id: string;
  memberId: string;
  role: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve OrganizationProfile.id from the BetterAuth Organization.id (orgId).
 * The [orgId] route param is the BetterAuth id, not the OrganizationProfile PK.
 */
async function resolveOrgProfile(orgId: string) {
  return prisma.organizationProfile.findUnique({
    where: { organizationId: orgId },
  });
}

// ---------------------------------------------------------------------------
// Prefetch functions
// ---------------------------------------------------------------------------

/**
 * Prefetch org analytics for the home dashboard.
 * Mirrors the query in `app/api/organizations/[orgId]/analytics/route.ts`.
 */
export async function prefetchOrgAnalytics(
  orgId: string,
): Promise<OrgAnalytics | null> {
  try {
    const org = await resolveOrgProfile(orgId);
    if (!org) return null;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      memberCount,
      learnerCount,
      planCount,
      monthBookings,
      lastMonthBookings,
      monthGross,
    ] = await Promise.all([
      prisma.organizationMemberProfile.count({
        where: { organizationProfileId: org.id, status: "ACTIVE" },
      }),
      prisma.organizationMemberProfile.count({
        where: {
          organizationProfileId: org.id,
          role: "ORG_LEARNER",
          status: "ACTIVE",
        },
      }),
      prisma.organizationPlan.count({
        where: { organizationProfileId: org.id, isActive: true },
      }),
      prisma.payment.count({
        where: {
          organizationProfileId: org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: monthStart },
        },
      }),
      prisma.payment.count({
        where: {
          organizationProfileId: org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: lastMonthStart, lt: monthStart },
        },
      }),
      prisma.payment.aggregate({
        where: {
          organizationProfileId: org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      members: { total: memberCount, learners: learnerCount },
      plans: { active: planCount },
      bookings: {
        monthToDate: monthBookings,
        lastMonth: lastMonthBookings,
        deltaPct: lastMonthBookings
          ? ((monthBookings - lastMonthBookings) / lastMonthBookings) * 100
          : null,
      },
      revenue: { monthToDateGross: monthGross._sum.amount ?? 0 },
      seatsTotal: org.seatsTotal,
      seatsUsed: org.seatsUsed,
    };
  } catch (err) {
    console.error("[prefetchOrgAnalytics] error:", err);
    return null;
  }
}

/**
 * Prefetch org billing summary.
 * Mirrors the query in `app/api/organizations/[orgId]/billing/route.ts`.
 */
export async function prefetchOrgBilling(
  orgId: string,
): Promise<OrgBilling | null> {
  try {
    const org = await resolveOrgProfile(orgId);
    if (!org) return null;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      monthAggregate,
      outstandingAggregate,
      pendingChargesRaw,
      creditPool,
    ] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          organizationProfileId: org.id,
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: monthStart },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.organizationInvoice.aggregate({
        where: {
          organizationProfileId: org.id,
          status: { in: ["SENT", "OVERDUE"] },
        },
        _sum: { amount: true },
        _count: true,
      }),
      org.billingMode === "INVOICED_MONTHLY"
        ? prisma.payment.findMany({
            where: {
              organizationProfileId: org.id,
              paymentStatus: "SUCCEEDED",
              paymentMethod: "ORG_INVOICED",
              billableToOrgInvoiceId: null,
            },
            select: {
              amount: true,
              refunds: {
                where: { status: "SUCCEEDED" },
                select: { amount: true },
              },
            },
          })
        : Promise.resolve(null),
      org.billingMode === "SEAT_PACK"
        ? prisma.orgCreditPool.findUnique({
            where: { organizationProfileId: org.id },
          })
        : Promise.resolve(null),
    ]);

    let pendingCharges: { amount: number; paymentCount: number } | null = null;
    if (pendingChargesRaw) {
      const payments = pendingChargesRaw as Array<{
        amount: number;
        refunds: Array<{ amount: number }>;
      }>;
      const netAmount = payments.reduce((sum, p) => {
        const refunded = p.refunds.reduce((s, r) => s + r.amount, 0);
        return sum + Math.max(0, (p.amount ?? 0) - refunded);
      }, 0);
      pendingCharges = { amount: netAmount, paymentCount: payments.length };
    }

    return {
      billingMode: org.billingMode,
      currency: "INR",
      monthToDate: {
        gross: monthAggregate._sum.amount ?? 0,
        paymentCount: monthAggregate._count,
      },
      outstanding: {
        amount: outstandingAggregate._sum.amount ?? 0,
        invoiceCount: outstandingAggregate._count,
      },
      pendingCharges,
      creditPool: creditPool
        ? {
            balance: creditPool.balance,
            totalPurchased: creditPool.totalPurchased,
          }
        : null,
      orgInvoiceCreditLimit: org.orgInvoiceCreditLimit,
      paymentTermsDays: org.paymentTermsDays,
    };
  } catch (err) {
    console.error("[prefetchOrgBilling] error:", err);
    return null;
  }
}

/**
 * Prefetch org members list.
 * Mirrors the query in `app/api/organizations/[orgId]/members/route.ts`.
 */
export async function prefetchOrgMembers(
  orgId: string,
): Promise<{ members: MemberRow[] } | null> {
  try {
    const org = await resolveOrgProfile(orgId);
    if (!org) return null;

    const members = await prisma.organizationMemberProfile.findMany({
      where: { organizationProfileId: org.id },
      include: {
        member: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      members: members.map((m) => ({
        id: m.id,
        memberId: m.memberId,
        role: m.role,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
        user: m.member.user,
      })),
    };
  } catch (err) {
    console.error("[prefetchOrgMembers] error:", err);
    return null;
  }
}
