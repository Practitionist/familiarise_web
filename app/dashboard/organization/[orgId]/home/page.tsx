"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Users,
  GraduationCap,
  Briefcase,
  CreditCard,
  AlertCircle,
} from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/DashboardShell";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { formatCurrencyAmount } from "@/utils/formatting";

interface OrgAnalytics {
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

interface OrgBilling {
  billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY";
  outstanding: { amount: number; invoiceCount: number };
  pendingCharges: { amount: number; paymentCount: number } | null;
  creditPool: { balance: number; totalPurchased: number } | null;
}

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

async function fetchBilling(orgId: string): Promise<OrgBilling> {
  const res = await fetch(`/api/organizations/${orgId}/billing`);
  if (!res.ok) throw new Error("Failed to load billing");
  return res.json();
}

export default function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);

  const analytics = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
  });
  const billing = useQuery({
    queryKey: ["org-billing", orgId],
    queryFn: () => fetchBilling(orgId),
  });

  const isLoading = analytics.isLoading || billing.isLoading;

  return (
    <>
      <DashboardHeader
        title="Overview"
        subtitle="Snapshot of members, plans, bookings, and billing"
      />
      <DashboardContent>
        {isLoading ? (
          <DashboardGrid columns={4}>
            {[1, 2, 3, 4].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : (
          <DashboardGrid columns={4}>
            <StatCard
              title="Active members"
              value={analytics.data?.members.total ?? 0}
              subtitle={`${analytics.data?.members.learners ?? 0} learners`}
              icon={Users}
              variant="info"
            />
            <StatCard
              title="Learners"
              value={analytics.data?.members.learners ?? 0}
              subtitle={
                analytics.data?.seatsTotal
                  ? `${analytics.data.seatsUsed} / ${analytics.data.seatsTotal} seats`
                  : "Unlimited seats"
              }
              icon={GraduationCap}
            />
            <StatCard
              title="Active plans"
              value={analytics.data?.plans.active ?? 0}
              icon={Briefcase}
            />
            <StatCard
              title="This month"
              value={formatCurrencyAmount(
                analytics.data?.revenue.monthToDateGross ?? 0,
                "INR",
              )}
              subtitle={`${analytics.data?.bookings.monthToDate ?? 0} bookings`}
              icon={CreditCard}
              variant="success"
              trend={
                analytics.data?.bookings.deltaPct != null
                  ? {
                      value: Math.round(analytics.data.bookings.deltaPct),
                      isPositive: analytics.data.bookings.deltaPct >= 0,
                    }
                  : undefined
              }
            />
          </DashboardGrid>
        )}

        {!isLoading && billing.data && (
          <div className="mt-6">
            <DashboardGrid columns={3}>
              {billing.data.billingMode === "INVOICED_MONTHLY" &&
                billing.data.pendingCharges && (
                  <StatCard
                    title="Pending charges"
                    value={formatCurrencyAmount(
                      billing.data.pendingCharges.amount,
                      "INR",
                    )}
                    subtitle={`${billing.data.pendingCharges.paymentCount} bookings not yet invoiced`}
                    icon={AlertCircle}
                    variant="warning"
                  />
                )}
              {billing.data.billingMode === "SEAT_PACK" &&
                billing.data.creditPool && (
                  <StatCard
                    title="Credit balance"
                    value={formatCurrencyAmount(
                      billing.data.creditPool.balance,
                      "INR",
                    )}
                    subtitle={`${formatCurrencyAmount(
                      billing.data.creditPool.totalPurchased,
                      "INR",
                    )} lifetime`}
                    icon={CreditCard}
                  />
                )}
              <StatCard
                title="Outstanding invoices"
                value={billing.data.outstanding.invoiceCount}
                subtitle={formatCurrencyAmount(
                  billing.data.outstanding.amount,
                  "INR",
                )}
                icon={AlertCircle}
                variant={
                  billing.data.outstanding.invoiceCount > 0
                    ? "warning"
                    : "default"
                }
              />
            </DashboardGrid>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
