"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Users,
  Briefcase,
  Calendar,
  CreditCard,
  GraduationCap,
  TrendingUp,
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

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

export default function OrgAnalyticsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { data, isLoading } = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
  });

  if (isLoading) {
    return (
      <>
        <DashboardHeader title="Analytics" subtitle="Activity at a glance" />
        <DashboardContent>
          <DashboardGrid columns={3}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      <DashboardHeader title="Analytics" subtitle="Activity at a glance" />
      <DashboardContent>
        <DashboardGrid columns={3}>
          <StatCard
            title="Members"
            value={data?.members.total ?? 0}
            icon={Users}
          />
          <StatCard
            title="Learners"
            value={data?.members.learners ?? 0}
            subtitle={
              data?.seatsTotal
                ? `${data.seatsUsed} / ${data.seatsTotal} seats`
                : "Unlimited seats"
            }
            icon={GraduationCap}
          />
          <StatCard
            title="Active plans"
            value={data?.plans.active ?? 0}
            icon={Briefcase}
          />
          <StatCard
            title="Bookings (this month)"
            value={data?.bookings.monthToDate ?? 0}
            icon={Calendar}
            trend={
              data?.bookings.deltaPct != null
                ? {
                    value: Math.round(data.bookings.deltaPct),
                    isPositive: data.bookings.deltaPct >= 0,
                  }
                : undefined
            }
          />
          <StatCard
            title="Bookings (last month)"
            value={data?.bookings.lastMonth ?? 0}
            icon={TrendingUp}
          />
          <StatCard
            title="Revenue (this month)"
            value={formatCurrencyAmount(
              data?.revenue.monthToDateGross ?? 0,
              "INR",
            )}
            icon={CreditCard}
            variant="success"
          />
        </DashboardGrid>
      </DashboardContent>
    </>
  );
}
