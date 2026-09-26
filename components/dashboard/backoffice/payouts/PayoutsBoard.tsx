"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import PendingPayoutsSection from "./sections/PendingPayoutsSection";
import { PayoutListSection } from "./sections/PayoutListSection";

// Lazy-load recharts so it stays out of this route's first-load JS.
const PayoutsChart = dynamic(() => import("./PayoutsChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[200px] w-full animate-pulse rounded-md bg-muted" />
  ),
});

// #1527 — five tabs covering every PayoutStatus; the inner Earnings tab is
// gone (Earnings has its own Money item).
type TabKey = "awaiting" | "scheduled" | "in-flight" | "failed" | "paid";

const VALID_TABS: readonly TabKey[] = [
  "awaiting",
  "scheduled",
  "in-flight",
  "failed",
  "paid",
] as const;

/** Old `?tab=` values keep landing somewhere sensible. */
const LEGACY_TABS: Record<string, TabKey> = {
  pending: "awaiting",
  processing: "in-flight",
  completed: "paid",
};

const parseTab = (value: string | null): TabKey => {
  if ((VALID_TABS as readonly string[]).includes(value ?? "")) {
    return value as TabKey;
  }
  return LEGACY_TABS[value ?? ""] ?? "awaiting";
};

interface PayoutTrendSeriesDatum {
  day: string;
  label: string;
  totalPaise: number;
}

interface PayoutTrendResponse {
  series: PayoutTrendSeriesDatum[];
}

// #997 secondary findings — the 7-day bucketing used to run client-side over
// a `?limit=100` guess (not 7-day-safe at scale). The server now returns an
// already-bucketed, bounded 7-day series via /api/admin/payouts/trend.
async function fetchPayoutTrend(): Promise<PayoutTrendResponse> {
  const response = await fetch("/api/admin/payouts/trend");
  if (!response.ok) {
    throw new Error("Failed to fetch payout trend");
  }
  return response.json() as Promise<PayoutTrendResponse>;
}

export function PayoutsBoard() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const urlTab = parseTab(tabParam);

  // URL writes go through window.history.replaceState rather than
  // router.replace: the tab panels are client state (each section fetches
  // client-side) and this page reads no search params server-side, so a
  // router navigation would re-render the tree via useSearchParams
  // reactivity for no benefit (same discipline as
  // components/dashboard/UrlTabs.tsx). Local state flips the panel
  // immediately since replaceState does not update useSearchParams; an
  // external URL change wins back over a stale local pick.
  const [localTab, setLocalTab] = useState<TabKey | null>(null);
  const activeTab: TabKey = localTab ?? urlTab;
  useEffect(() => {
    setLocalTab(null);
  }, [tabParam]);

  const handleTabChange = (value: string) => {
    const nextTab = parseTab(value);
    setLocalTab(nextTab);
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    next.set("tab", nextTab);
    const target = `?${next.toString()}`;
    if (target !== window.location.search) {
      window.history.replaceState(window.history.state, "", target);
    }
  };

  const { data: trendData, isLoading: trendLoading } = useQuery({
    queryKey: ["admin-payout-trend"],
    queryFn: fetchPayoutTrend,
    staleTime: 60 * 1000,
  });

  const chartData = useMemo(
    () =>
      (trendData?.series ?? []).map((d) => ({
        day: d.day,
        label: d.label,
        // amounts are paise server-side — normalize to major units for display.
        total: d.totalPaise / 100,
      })),
    [trendData?.series],
  );

  const hasAnyTrendData = chartData.some((d) => d.total > 0);
  let trendBody = (
    <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
      Analytics coming soon
    </div>
  );
  if (trendLoading) trendBody = <Skeleton className="h-[200px] w-full" />;
  else if (hasAnyTrendData) trendBody = <PayoutsChart data={chartData} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payouts"
        description="Consultant payouts from approval to the bank."
      />

      {/* Payout trend chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Payouts - Last 7 Days</CardTitle>
        </CardHeader>
        <CardContent>{trendBody}</CardContent>
      </Card>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="w-full"
      >
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">
          <TabsTrigger value="awaiting">Awaiting approval</TabsTrigger>
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="in-flight">In flight</TabsTrigger>
          <TabsTrigger value="failed">Failed &amp; returned</TabsTrigger>
          <TabsTrigger value="paid">Paid</TabsTrigger>
        </TabsList>

        <TabsContent value="awaiting" className="mt-6">
          <PendingPayoutsSection />
        </TabsContent>
        <TabsContent value="scheduled" className="mt-6">
          <PayoutListSection
            statuses={["APPROVED"]}
            name="scheduled"
            empty="No approved payouts are waiting for the next run."
            note="Approved and waiting for the payout run to send them."
          />
        </TabsContent>
        <TabsContent value="in-flight" className="mt-6">
          <PayoutListSection
            statuses={["PROCESSING"]}
            name="in-flight"
            empty="No payouts are with the provider right now."
            note="Sent to the provider; the webhook moves each to Paid or Failed."
          />
        </TabsContent>
        <TabsContent value="failed" className="mt-6">
          <PayoutListSection
            statuses={["FAILED", "CANCELLED", "REVERSED"]}
            name="failed"
            empty="No failed, cancelled or reversed payouts."
          />
        </TabsContent>
        <TabsContent value="paid" className="mt-6">
          <PayoutListSection
            statuses={["COMPLETED"]}
            name="paid"
            empty="No payouts have been paid yet."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
