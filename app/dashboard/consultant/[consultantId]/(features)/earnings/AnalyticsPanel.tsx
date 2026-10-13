"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parse } from "date-fns";
import {
  BarChart3,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  IndianRupee,
  Link2,
  Repeat,
  Store,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import {
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { DataCard, EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useSession } from "@/lib/auth-client";
import { getAppointmentStatus } from "../../utils/appointmentHelpers";
import { formatCurrencyAmount } from "@/utils/formatting";
import type {
  ActiveFeeSchedule,
  AttributionBreakdown,
  MonthlyEarning,
  RepeatLearnerStats,
} from "@/lib/data/consultant-earnings-analytics";
import type { BucketSums } from "@/lib/dashboard/earnings-state";

interface EarningsAnalyticsResponse {
  summary: {
    totalEarnings: number;
    pendingEarnings: number;
    readyEarnings: number;
    paidEarnings: number;
    heldEarnings: number;
    pendingTrustEarnings: number;
  };
  totals?: BucketSums;
  feeSchedule?: ActiveFeeSchedule;
  monthlyEarnings?: MonthlyEarning[];
  attributionBreakdown?: AttributionBreakdown;
  repeatLearnerStats?: RepeatLearnerStats;
}

const formatInr = (paise: number) => formatCurrencyAmount(paise, "INR");

function formatBpsRate(bps: number): string {
  const pct = bps / 100;
  return `${bps % 100 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

const monthLabel = (month: string) =>
  format(parse(month, "yyyy-MM", new Date()), "MMM");

function formatChannelSubtitle(opts: {
  hasB2C: boolean;
  pct: number;
  count: number;
  feeLabel: string | null;
  keepLabel: string | null;
  fallbackKeepPrefix: string;
  fallbackDefault: string;
}): string {
  if (opts.hasB2C) {
    const noun = opts.count === 1 ? "booking" : "bookings";
    const feeSuffix = opts.feeLabel ? ` (${opts.feeLabel} fee)` : "";
    return `${opts.pct}% of B2C · ${opts.count} ${noun}${feeSuffix}`;
  }
  if (opts.keepLabel) {
    return opts.fallbackKeepPrefix.replace("{keep}", opts.keepLabel);
  }
  return opts.fallbackDefault;
}

export default function AnalyticsPanel({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data: session } = useSession();
  const isOwnDashboard =
    (session?.user as { consultantProfileId?: string } | undefined)
      ?.consultantProfileId === consultantId;

  const {
    data: earningsData,
    isLoading: earningsLoading,
    isError: earningsError,
    refetch: refetchEarnings,
  } = useQuery<EarningsAnalyticsResponse>({
    queryKey: ["consultant-earnings-analytics", consultantId],
    queryFn: async () => {
      const res = await fetch(
        "/api/consultant/earnings?includeMonthly=1&limit=1",
      );
      if (!res.ok) throw new Error("Failed to fetch earnings analytics");
      return res.json();
    },
    staleTime: 60_000,
    retry: 2,
    enabled: isOwnDashboard,
  });

  const retryEarnings = () => {
    if (isOwnDashboard) void refetchEarnings();
  };

  const appointmentsQuery = createConsultantQueries(
    consultantId,
    "personal",
  ).appointments;
  const {
    data: appointments,
    isLoading: appointmentsLoading,
    isError: appointmentsError,
    refetch: refetchAppointments,
  } = useQuery(appointmentsQuery);

  const sessionStats = useMemo(() => {
    const all = appointments ?? [];
    let completed = 0;
    let cancelled = 0;
    let upcoming = 0;
    for (const appointment of all) {
      const status = getAppointmentStatus(appointment);
      if (status === "Completed") completed += 1;
      else if (status === "Cancelled") cancelled += 1;
      else if (status !== "Not Scheduled") upcoming += 1;
    }
    const settled = completed + cancelled;
    return {
      completed,
      upcoming,
      completionRate:
        settled > 0 ? Math.round((completed / settled) * 100) : null,
    };
  }, [appointments]);

  const monthly = earningsData?.monthlyEarnings ?? [];
  const chartData = monthly.map((m) => ({
    label: monthLabel(m.month),
    totalInr: m.totalPaise / 100,
    count: m.count,
  }));
  const hasAnyEarnings =
    (earningsData?.summary.totalEarnings ?? 0) > 0 ||
    monthly.some((m) => m.count > 0);

  const attribution = earningsData?.attributionBreakdown;
  const ownLinkPaise = attribution?.ownLinkPaise;
  const marketplacePaise = attribution?.marketplacePaise;
  const totalB2CPaise = (ownLinkPaise ?? 0) + (marketplacePaise ?? 0);
  const ownLinkPct =
    totalB2CPaise > 0
      ? Math.round(((ownLinkPaise ?? 0) / totalB2CPaise) * 100)
      : 0;
  const marketplacePct = totalB2CPaise > 0 ? 100 - ownLinkPct : 0;
  const repeatStats = earningsData?.repeatLearnerStats;
  const feeSchedule = earningsData?.feeSchedule;
  const ownFeeLabel = feeSchedule
    ? formatBpsRate(feeSchedule.ownLinkBps)
    : null;
  const mktFeeLabel = feeSchedule
    ? formatBpsRate(feeSchedule.marketplaceBps)
    : null;
  const ownKeepLabel = feeSchedule
    ? formatBpsRate(10_000 - feeSchedule.ownLinkBps)
    : null;
  const mktKeepLabel = feeSchedule
    ? formatBpsRate(10_000 - feeSchedule.marketplaceBps)
    : null;

  return (
    <DashboardErrorBoundary>
      <DashboardContent className="px-0 lg:px-0">
        {earningsLoading || appointmentsLoading ? (
          <DashboardGrid columns={3}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : earningsError && appointmentsError ? (
          <EmptyState
            icon={BarChart3}
            title="Couldn't load analytics"
            description="Both the earnings and session reads failed. Please retry."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  retryEarnings();
                  void refetchAppointments();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <DashboardGrid columns={3}>
            <StatCard
              title="Own-Link Revenue"
              value={
                earningsError || ownLinkPaise === undefined
                  ? "—"
                  : formatInr(ownLinkPaise)
              }
              icon={Link2}
              variant="success"
              subtitle={formatChannelSubtitle({
                hasB2C: Boolean(attribution && totalB2CPaise > 0),
                pct: ownLinkPct,
                count: attribution?.ownLinkCount ?? 0,
                feeLabel: ownFeeLabel,
                keepLabel: ownKeepLabel,
                fallbackKeepPrefix:
                  "Keep {keep} before TDS when learners first book via ?via=",
                fallbackDefault:
                  "Reduced fee when learners first book via your shared link",
              })}
              tooltip="Net B2C revenue from buyers whose first purchase with you came through your personal share link (?via=)."
            />
            <StatCard
              title="Marketplace Revenue"
              value={
                earningsError || marketplacePaise === undefined
                  ? "—"
                  : formatInr(marketplacePaise)
              }
              icon={Store}
              subtitle={formatChannelSubtitle({
                hasB2C: Boolean(attribution && totalB2CPaise > 0),
                pct: marketplacePct,
                count: attribution?.marketplaceCount ?? 0,
                feeLabel: mktFeeLabel,
                keepLabel: mktKeepLabel,
                fallbackKeepPrefix:
                  "Keep {keep} before TDS on Marketplace-acquired bookings",
                fallbackDefault:
                  "Marketplace fee rate on Marketplace-acquired bookings",
              })}
              tooltip="Net B2C revenue from buyers who first discovered you through the Familiarise Marketplace."
            />
            <StatCard
              title="Repeat Learner Rate"
              value={
                !earningsError &&
                typeof repeatStats?.repeatLearnerRate === "number"
                  ? `${repeatStats.repeatLearnerRate}%`
                  : "—"
              }
              icon={Repeat}
              subtitle={
                (repeatStats?.totalLearners ?? 0) > 0 && repeatStats
                  ? `${repeatStats.repeatLearners} of ${repeatStats.totalLearners} learners made 2+ bookings`
                  : "Learners with 2+ paid bookings"
              }
              tooltip="Share of your distinct B2C learners who have completed two or more separate paid purchases with you."
            />
            <StatCard
              title="Sessions Completed"
              value={appointmentsError ? "—" : sessionStats.completed}
              icon={CheckCircle2}
              tooltip="Completed appointments in your personal practice."
            />
            <StatCard
              title="Upcoming Sessions"
              value={appointmentsError ? "—" : sessionStats.upcoming}
              icon={CalendarClock}
            />
            <StatCard
              title="Completion Rate"
              value={
                appointmentsError || sessionStats.completionRate === null
                  ? "—"
                  : `${sessionStats.completionRate}%`
              }
              icon={BarChart3}
              tooltip="Completed sessions as a share of all settled (completed + cancelled) sessions."
            />
          </DashboardGrid>
        )}

        {/* Charts */}
        <div className="mt-6 grid gap-4 lg:gap-6 grid-cols-1 lg:grid-cols-2">
          <DataCard title="Earnings — last 6 months">
            {earningsLoading ? (
              <Skeleton className="h-[220px] w-full rounded-lg" />
            ) : earningsError ? (
              <EmptyState
                icon={BarChart3}
                title="Couldn't load earnings trend"
                action={
                  <Button variant="outline" size="sm" onClick={retryEarnings}>
                    Retry
                  </Button>
                }
              />
            ) : !hasAnyEarnings ? (
              <EmptyState
                icon={IndianRupee}
                title="No earnings yet"
                description="Once you complete paid sessions, your monthly earnings trend shows up here."
              />
            ) : (
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                    <XAxis
                      dataKey="label"
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) =>
                        value >= 1000
                          ? `${(value / 1000).toFixed(1)}k`
                          : String(value)
                      }
                    />
                    <Tooltip
                      formatter={(value) =>
                        // Recharts can hand the formatter undefined/arrays
                        // on empty data points — never call toLocaleString
                        // on a non-number.
                        typeof value === "number"
                          ? value.toLocaleString(undefined, {
                              style: "currency",
                              currency: "INR",
                              maximumFractionDigits: 0,
                            })
                          : ""
                      }
                    />
                    <Bar
                      dataKey="totalInr"
                      name="Earnings"
                      fill="#71717a"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </DataCard>

          <DataCard title="Earning sessions — last 6 months">
            {earningsLoading ? (
              <Skeleton className="h-[220px] w-full rounded-lg" />
            ) : earningsError ? (
              <EmptyState
                icon={BarChart3}
                title="Couldn't load session trend"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    // Session trend derives from the appointments query —
                    // the earnings refetch was the wrong retry target.
                    onClick={() => void refetchAppointments()}
                  >
                    Retry
                  </Button>
                }
              />
            ) : !hasAnyEarnings ? (
              <EmptyState
                icon={CalendarCheck}
                title="No sessions yet"
                description="Session volume per month appears here once earnings start flowing."
              />
            ) : (
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                    <XAxis
                      dataKey="label"
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="count"
                      name="Sessions"
                      stroke="#18181b"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </DataCard>
        </div>
      </DashboardContent>
    </DashboardErrorBoundary>
  );
}
