"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  RefreshCw,
  ShieldCheck,
  Ticket,
  Users,
} from "lucide-react";

import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { Section } from "@/components/dashboard/Section";
import { Stat, StatRow, StatSkeleton } from "@/components/dashboard/Stat";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { durationLabel } from "@/lib/support/case-format";
import type { InboxStats } from "@/types/support-case";

interface StaffMetrics {
  supportMetrics: {
    ticketsResolvedToday: number;
    ticketsResolvedThisWeek: number;
    ticketsResolvedThisMonth: number;
    openTickets: number;
    avgResponseTimeHours: number;
  };
  userMetrics: {
    usersHelpedThisWeek: number;
    activeUsers: number;
    newSignupsThisMonth: number;
    totalUsers: number;
  };
  platformMetrics: {
    totalAppointments: number;
    pendingPayments: number;
  };
}

const DEFAULT_METRICS: StaffMetrics = {
  supportMetrics: {
    ticketsResolvedToday: 0,
    ticketsResolvedThisWeek: 0,
    ticketsResolvedThisMonth: 0,
    openTickets: 0,
    avgResponseTimeHours: 0,
  },
  userMetrics: {
    usersHelpedThisWeek: 0,
    activeUsers: 0,
    newSignupsThisMonth: 0,
    totalUsers: 0,
  },
  platformMetrics: {
    totalAppointments: 0,
    pendingPayments: 0,
  },
};

const PERIOD_LABELS: Record<string, string> = {
  today: "Today",
  week: "This Week",
  month: "This Month",
};

function getResolvedTicketsForPeriod(
  supportMetrics: StaffMetrics["supportMetrics"],
  period: string,
): number {
  if (period === "today") return supportMetrics.ticketsResolvedToday;
  if (period === "month") return supportMetrics.ticketsResolvedThisMonth;
  return supportMetrics.ticketsResolvedThisWeek;
}

function getSlaAttainmentTone(
  slaBreaches: number,
  slaAttainmentPct: number,
): "critical" | "warning" | "success" {
  if (slaBreaches > 0) return "critical";
  if (slaAttainmentPct < 95) return "warning";
  return "success";
}

function formatFirstResponseValue(
  avgFirstResponseMs: number | null | undefined,
  avgResponseTimeHours: number,
): string {
  if (avgFirstResponseMs !== null && avgFirstResponseMs !== undefined) {
    return durationLabel(avgFirstResponseMs);
  }
  if (avgResponseTimeHours > 0) {
    return `${avgResponseTimeHours}h`;
  }
  return "N/A";
}

export default function StaffMetricsPage() {
  const [period, setPeriod] = useState("week");

  const {
    data: rawMetrics,
    isLoading: loading,
    isError,
    refetch,
  } = useQuery<StaffMetrics>({
    queryKey: ["staff-metrics"],
    queryFn: async () => {
      const response = await fetch("/api/staff/metrics");
      if (!response.ok) throw new Error("Failed to fetch metrics");
      return response.json();
    },
    staleTime: 2 * 60 * 1000,
  });

  const slaStats = useQuery<InboxStats>({
    queryKey: ["support-inbox-stats"],
    queryFn: async () => {
      const res = await fetch("/api/staff/support-inbox/stats");
      if (!res.ok) throw new Error("Failed to fetch support SLA stats");
      return res.json();
    },
    staleTime: 60_000,
  });

  const supportMetrics =
    rawMetrics?.supportMetrics ?? DEFAULT_METRICS.supportMetrics;
  const userMetrics = rawMetrics?.userMetrics ?? DEFAULT_METRICS.userMetrics;
  const platformMetrics =
    rawMetrics?.platformMetrics ?? DEFAULT_METRICS.platformMetrics;

  const periodLabel = PERIOD_LABELS[period] ?? "This Week";
  const resolvedInPeriod = getResolvedTicketsForPeriod(supportMetrics, period);
  const openCases = slaStats.data?.openCases ?? supportMetrics.openTickets;
  const slaBreaches = slaStats.data?.slaBreaches ?? 0;
  const slaAttainmentPct =
    openCases > 0
      ? Math.max(0, Math.round(((openCases - slaBreaches) / openCases) * 100))
      : 100;
  const totalHandledInPeriod = resolvedInPeriod + supportMetrics.openTickets;
  const resolutionRate =
    totalHandledInPeriod > 0
      ? Math.round((resolvedInPeriod / totalHandledInPeriod) * 100)
      : 0;

  return (
    <>
      <PageHeader
        title="Performance Metrics"
        description="Support queue health, statutory SLA attainment, and platform operations"
        actions={
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger aria-label="Select period" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">This Week</SelectItem>
                <SelectItem value="month">This Month</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                void refetch();
                void slaStats.refetch();
              }}
              aria-label="Refresh metrics"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      <DashboardContent>
        {isError ? (
          <ErrorState
            title="Metrics could not be loaded"
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <Section
              title="Support Queue Health & Statutory SLA Attainment"
              description="Live acknowledgement and resolution SLA compliance across active cases"
            >
              <StatRow>
                {loading && slaStats.isLoading ? (
                  [1, 2, 3, 4].map((i) => <StatSkeleton key={i} />)
                ) : (
                  <>
                    <Stat
                      label="SLA Attainment"
                      value={`${slaAttainmentPct}%`}
                      hint={
                        slaBreaches === 0
                          ? "All open cases within statutory ceiling"
                          : `${slaBreaches} active case(s) breached`
                      }
                      icon={ShieldCheck}
                      tone={getSlaAttainmentTone(slaBreaches, slaAttainmentPct)}
                    />
                    <Stat
                      label="SLA Breaches"
                      value={slaBreaches}
                      hint="Acknowledgement or resolution overdue"
                      icon={AlertTriangle}
                      tone={slaBreaches > 0 ? "critical" : "neutral"}
                    />
                    <Stat
                      label="Avg First Response"
                      value={formatFirstResponseValue(
                        slaStats.data?.avgFirstResponseMs,
                        supportMetrics.avgResponseTimeHours,
                      )}
                      hint={`${slaStats.data?.windowDays ?? 7}-day rolling window`}
                      icon={Clock}
                    />
                    <Stat
                      label="Resolution Rate"
                      value={`${resolutionRate}%`}
                      hint={`${resolvedInPeriod} resolved (${periodLabel})`}
                      icon={CheckCircle}
                      tone={resolutionRate >= 80 ? "success" : "neutral"}
                    />
                  </>
                )}
              </StatRow>
            </Section>

            <Section title={`Queue Volume (${periodLabel})`}>
              <StatRow>
                {loading ? (
                  [1, 2, 3, 4].map((i) => <StatSkeleton key={i} />)
                ) : (
                  <>
                    <Stat
                      label="Tickets Resolved"
                      value={resolvedInPeriod}
                      hint={periodLabel}
                      icon={CheckCircle}
                      tone="success"
                    />
                    <Stat
                      label="Open Cases"
                      value={openCases}
                      hint={`${supportMetrics.openTickets} open support tickets`}
                      icon={Ticket}
                      tone={openCases > 0 ? "warning" : "neutral"}
                    />
                    <Stat
                      label="Users Helped"
                      value={userMetrics.usersHelpedThisWeek}
                      hint="Distinct users this week"
                      icon={Users}
                    />
                    <Stat
                      label="Active Users"
                      value={userMetrics.activeUsers}
                      hint="With payments this month"
                      icon={Activity}
                    />
                  </>
                )}
              </StatRow>
            </Section>

            <Section title="Platform Overview">
              <StatRow>
                {loading ? (
                  [1, 2, 3].map((i) => <StatSkeleton key={i} />)
                ) : (
                  <>
                    <Stat
                      label="Total Users"
                      value={userMetrics.totalUsers.toLocaleString()}
                      hint={`+${userMetrics.newSignupsThisMonth} new this month`}
                      icon={Users}
                    />
                    <Stat
                      label="Total Appointments"
                      value={platformMetrics.totalAppointments.toLocaleString()}
                      hint="All-time sessions"
                      icon={Activity}
                    />
                    <Stat
                      label="Pending Payments"
                      value={platformMetrics.pendingPayments}
                      hint="Awaiting settlement"
                      icon={Clock}
                      tone={
                        platformMetrics.pendingPayments > 0
                          ? "warning"
                          : "neutral"
                      }
                    />
                  </>
                )}
              </StatRow>
            </Section>
          </>
        )}
      </DashboardContent>
    </>
  );
}
