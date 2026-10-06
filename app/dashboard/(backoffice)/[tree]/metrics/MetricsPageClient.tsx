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

interface MetricsData {
  period: string;
  tickets: {
    resolved: number;
    open: number;
    inProgress: number;
    avgResponseHours: number | null;
    avgResolutionHours: number | null;
    resolutionRate: number;
  };
  users: {
    newThisPeriod: number;
    total: number;
  };
  appointments: {
    totalThisPeriod: number;
    completedThisPeriod: number;
    completionRate: number;
  };
  feedbacks: {
    thisPeriod: number;
  };
  supportRequests: {
    pending: number;
  };
  activityTrend: Record<string, number>;
}

const DEFAULT_METRICS: MetricsData = {
  period: "week",
  tickets: {
    resolved: 0,
    open: 0,
    inProgress: 0,
    avgResponseHours: null,
    avgResolutionHours: null,
    resolutionRate: 0,
  },
  users: { newThisPeriod: 0, total: 0 },
  appointments: {
    totalThisPeriod: 0,
    completedThisPeriod: 0,
    completionRate: 0,
  },
  feedbacks: { thisPeriod: 0 },
  supportRequests: { pending: 0 },
  activityTrend: {},
};

export default function StaffMetricsPage() {
  const [period, setPeriod] = useState("week");

  const {
    data: metrics = DEFAULT_METRICS,
    isLoading: loading,
    isError,
    refetch,
  } = useQuery<MetricsData>({
    queryKey: ["staff-metrics", period],
    queryFn: async () => {
      const response = await fetch(`/api/staff/metrics?period=${period}`);
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

  const periodLabels: Record<string, string> = {
    today: "Today",
    week: "This Week",
    month: "This Month",
  };

  const openCases = slaStats.data?.openCases ?? metrics.tickets.open;
  const slaBreaches = slaStats.data?.slaBreaches ?? 0;
  const slaAttainmentPct =
    openCases > 0
      ? Math.max(0, Math.round(((openCases - slaBreaches) / openCases) * 100))
      : 100;

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
                      tone={
                        slaBreaches > 0
                          ? "critical"
                          : slaAttainmentPct < 95
                            ? "warning"
                            : "success"
                      }
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
                      value={
                        slaStats.data?.avgFirstResponseMs !== null &&
                        slaStats.data?.avgFirstResponseMs !== undefined
                          ? durationLabel(slaStats.data.avgFirstResponseMs)
                          : metrics.tickets.avgResponseHours !== null
                            ? `${metrics.tickets.avgResponseHours}h`
                            : "N/A"
                      }
                      hint={`${slaStats.data?.windowDays ?? 7}-day rolling window`}
                      icon={Clock}
                    />
                    <Stat
                      label="Resolution Rate"
                      value={`${metrics.tickets.resolutionRate}%`}
                      hint={
                        metrics.tickets.avgResolutionHours !== null
                          ? `Avg resolution: ${metrics.tickets.avgResolutionHours}h`
                          : `${metrics.tickets.resolved} resolved (${periodLabels[period]})`
                      }
                      icon={CheckCircle}
                      tone={
                        metrics.tickets.resolutionRate >= 80
                          ? "success"
                          : "neutral"
                      }
                    />
                  </>
                )}
              </StatRow>
            </Section>

            <Section title={`Queue Volume (${periodLabels[period]})`}>
              <StatRow>
                {loading ? (
                  [1, 2, 3, 4].map((i) => <StatSkeleton key={i} />)
                ) : (
                  <>
                    <Stat
                      label="Tickets Resolved"
                      value={metrics.tickets.resolved}
                      hint={periodLabels[period]}
                      icon={CheckCircle}
                      tone="success"
                    />
                    <Stat
                      label="Open Cases"
                      value={openCases}
                      hint={`${metrics.tickets.inProgress} in progress`}
                      icon={Ticket}
                      tone={openCases > 0 ? "warning" : "neutral"}
                    />
                    <Stat
                      label="Session Support Requests"
                      value={metrics.supportRequests.pending}
                      hint="Pending action"
                      icon={Activity}
                    />
                    <Stat
                      label="Feedback Received"
                      value={metrics.feedbacks.thisPeriod}
                      hint={periodLabels[period]}
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
                      value={metrics.users.total.toLocaleString()}
                      hint={`+${metrics.users.newThisPeriod} ${periodLabels[period].toLowerCase()}`}
                      icon={Users}
                    />
                    <Stat
                      label={`Sessions (${periodLabels[period]})`}
                      value={metrics.appointments.totalThisPeriod}
                      hint={`${metrics.appointments.completedThisPeriod} completed`}
                      icon={Activity}
                    />
                    <Stat
                      label="Session Completion Rate"
                      value={`${metrics.appointments.completionRate}%`}
                      hint={periodLabels[period]}
                      icon={CheckCircle}
                    />
                  </>
                )}
              </StatRow>
            </Section>

            <Section
              title="7-Day Ticket Volume"
              description="Daily support ticket creation over the past 7 days"
              variant="card"
            >
              <div className="flex items-end justify-between gap-2 h-36 pt-4">
                {Object.entries(metrics.activityTrend).map(([date, count]) => {
                  const maxCount = Math.max(
                    ...Object.values(metrics.activityTrend),
                    1,
                  );
                  const height = (count / maxCount) * 100;
                  const dayLabel = new Date(date).toLocaleDateString("en-US", {
                    weekday: "short",
                  });
                  return (
                    <div
                      key={date}
                      className="flex-1 flex flex-col items-center gap-1"
                    >
                      <span className="text-xs font-medium tabular-nums">
                        {count}
                      </span>
                      <div className="w-full bg-muted rounded-t flex-1 relative min-h-[72px]">
                        <div
                          className="absolute bottom-0 left-0 right-0 bg-foreground rounded-t transition-all"
                          style={{ height: `${Math.max(height, 4)}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {dayLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Section>
          </>
        )}
      </DashboardContent>
    </>
  );
}
