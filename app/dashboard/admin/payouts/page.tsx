"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";

import PendingPayoutsSection from "./_sections/PendingPayoutsSection";
import ProcessingPayoutsSection from "./_sections/ProcessingPayoutsSection";
import CompletedPayoutsSection from "./_sections/CompletedPayoutsSection";
import EarningsSection from "./_sections/EarningsSection";

// Lazy-load recharts so it stays out of this route's first-load JS.
const PayoutsChart = dynamic(() => import("./PayoutsChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[200px] w-full animate-pulse rounded-md bg-muted" />
  ),
});

type TabKey = "pending" | "processing" | "completed" | "earnings";

const VALID_TABS: readonly TabKey[] = [
  "pending",
  "processing",
  "completed",
  "earnings",
] as const;

interface PayoutTrendDatum {
  createdAt: string;
  amount: number;
}

interface PayoutTrendResponse {
  payouts: PayoutTrendDatum[];
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

async function fetchPayoutTrend(): Promise<PayoutTrendResponse> {
  // TODO: If /api/admin/payouts?limit=100 doesn't return enough history for a
  // meaningful trend (e.g. paginated past the 7-day window), introduce a
  // dedicated trend endpoint rather than fetching more client-side.
  const response = await fetch("/api/admin/payouts?limit=100");
  if (!response.ok) {
    throw new Error("Failed to fetch payout trend");
  }
  return response.json() as Promise<PayoutTrendResponse>;
}

function formatDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function buildLast7DaysSeries(
  payouts: PayoutTrendDatum[] | undefined,
): Array<{ day: string; label: string; total: number }> {
  const now = new Date();
  const days: Array<{ day: string; label: string; total: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ day: formatDayKey(d), label: formatDayLabel(d), total: 0 });
  }
  if (!payouts?.length) return days;

  const index = new Map(days.map((d, i) => [d.day, i]));
  for (const p of payouts) {
    if (!p?.createdAt) continue;
    const d = new Date(p.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = formatDayKey(d);
    const idx = index.get(key);
    if (idx !== undefined) {
      // amounts are stored in minor units (paise/cents) — normalize to major
      days[idx].total += (p.amount || 0) / 100;
    }
  }
  return days;
}

export default function AdminPayoutsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: TabKey = (VALID_TABS as readonly string[]).includes(
    tabParam ?? "",
  )
    ? (tabParam as TabKey)
    : "pending";

  const handleTabChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(Array.from(searchParams.entries()));
      next.set("tab", value);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const { data: trendData, isLoading: trendLoading } = useQuery({
    queryKey: ["admin-payout-trend"],
    queryFn: fetchPayoutTrend,
    staleTime: 60 * 1000,
  });

  const chartData = useMemo(
    () => buildLast7DaysSeries(trendData?.payouts),
    [trendData?.payouts],
  );

  const hasAnyTrendData = chartData.some((d) => d.total > 0);

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Payouts"
        subtitle="Manage consultant payouts and earnings"
      />

      {/* Payout trend chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Payouts - Last 7 Days</CardTitle>
        </CardHeader>
        <CardContent>
          {trendLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : hasAnyTrendData ? (
            <PayoutsChart data={chartData} />
          ) : (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
              Analytics coming soon
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="grid h-auto w-full max-w-xl grid-cols-2 gap-1 sm:h-9 sm:grid-cols-4">
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="processing">Processing</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="earnings">Earnings</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-6">
          <PendingPayoutsSection />
        </TabsContent>
        <TabsContent value="processing" className="mt-6">
          <ProcessingPayoutsSection />
        </TabsContent>
        <TabsContent value="completed" className="mt-6">
          <CompletedPayoutsSection />
        </TabsContent>
        <TabsContent value="earnings" className="mt-6">
          <EarningsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
