"use client";

import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { EmptyState } from "@/components/dashboard/DataCard";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { HomeTab } from "./HomeTab";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

export default function HomePageClient({
  consultantId,
  viewerZone,
}: Readonly<{ consultantId: string; viewerZone: ViewerZone }>) {
  // The factory's staleTime (2 min) is deliberately NOT overridden here. This
  // used to force `staleTime: 0` under a comment about showing stale data
  // immediately, which is not what staleTime does: it marks the server-prefetched
  // cache entry stale on mount, so the client refetched
  // GET /api/dashboard/consultant/[id] straight after hydration and recomputed
  // the identical payload the page had just dehydrated — doubling every query
  // behind it. Harmless before #890 seeded the cache; pure waste after. (#1121)
  const dashboardQuery = {
    ...createConsultantQueries(consultantId).dashboard,
    refetchOnWindowFocus: false,
  };
  const {
    data: dashboardData,
    isLoading,
    error,
    refetch,
  } = useQuery<TConsultantDashboardResponse>(dashboardQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !dashboardData) {
    // Header is owned by the server page now — see its comment on FCP.
    return <HomeSkeleton withHeader={false} />;
  }

  if (error && !dashboardData) {
    return (
      <ErrorState
        title="Couldn't load your dashboard"
        description="Check your connection and try again."
        onRetry={() => void refetch()}
      />
    );
  }

  if (!dashboardData) {
    return (
      <DashboardErrorBoundary>
        <EmptyState
          icon={Inbox}
          title="No data available"
          description="Dashboard data not found for this consultant."
        />
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <HomeTab
        appointments={dashboardData.appointments}
        consultantId={consultantId}
        pendingRequestsCount={dashboardData.pendingRequestsCount ?? 0}
        orgSessions={dashboardData.orgSessions}
        payoutSetup={dashboardData.payoutSetup}
        needsYou={dashboardData.needsYou}
        sessionsDelivered={dashboardData.sessionsDelivered}
        responseRate={dashboardData.responseRate}
        viewerZone={viewerZone}
        performanceSnapshot={dashboardData.performanceSnapshot}
        financialSummary={dashboardData.financialSummary}
      />
    </DashboardErrorBoundary>
  );
}
