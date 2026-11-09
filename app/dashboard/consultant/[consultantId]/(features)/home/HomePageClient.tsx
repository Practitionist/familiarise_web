"use client";

import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { EmptyState } from "@/components/dashboard/DataCard";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useHomeRequests } from "@/components/dashboard/shared/requests/RequestsInboxPreview";
import { ExpertHomeSkeleton } from "./ExpertHomeSkeleton";
import { HomeTab } from "./HomeTab";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

export default function HomePageClient({
  consultantId,
  viewerZone,
  shareUrl,
}: Readonly<{
  consultantId: string;
  viewerZone: ViewerZone;
  shareUrl: string | null;
}>) {
  // The factory's staleTime (2 min) is not overridden: a shorter one would mark
  // the server-prefetched entry stale on mount and refetch the payload the page
  // just dehydrated.
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
  // Starts with the dashboard read, not after it, so the two never queue.
  const requests = useHomeRequests(consultantId);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !dashboardData) {
    // The server page owns the header.
    return <ExpertHomeSkeleton />;
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
          description="Dashboard data not found for this expert."
        />
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <HomeTab
        appointments={dashboardData.appointments}
        consultantId={consultantId}
        orgSessions={dashboardData.orgSessions}
        clientBookings={dashboardData.clientBookings}
        payoutSetup={dashboardData.payoutSetup}
        needsYou={dashboardData.needsYou}
        requests={requests}
        shareUrl={shareUrl}
        latestReview={dashboardData.latestReview}
        sessionsDelivered={dashboardData.sessionsDelivered}
        firstRun={dashboardData.firstRun}
        responseRate={dashboardData.responseRate}
        viewerZone={viewerZone}
        performanceSnapshot={dashboardData.performanceSnapshot}
        financialSummary={dashboardData.financialSummary}
      />
    </DashboardErrorBoundary>
  );
}
