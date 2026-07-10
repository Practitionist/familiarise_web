"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Inbox } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { HomeTab } from "./HomeTab";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

export default function HomePageClient({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const queryClient = useQueryClient();

  // Read consultant name from the cached profile (already fetched by layout)
  const consultantProfile = queryClient.getQueryData<{ user?: { name?: string } }>(["consultant-data", consultantId]);
  const consultantName = consultantProfile?.user?.name;

  // Use the centralized query configuration with optimized settings for immediate rendering
  const dashboardQuery = {
    ...createConsultantQueries(consultantId).dashboard,
    // Show stale data immediately while fetching in background
    staleTime: 0,
    refetchOnWindowFocus: false,
  };
  const {
    data: dashboardData,
    isLoading,
    isFetching,
    error,
    refetch,
    isStale: _isStale,
  } = useQuery<TConsultantDashboardResponse>(dashboardQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !dashboardData) {
    return <HomeSkeleton />;
  }

  if (error && !dashboardData) {
    return (
      <DashboardErrorBoundary>
        <EmptyState
          icon={AlertCircle}
          title="Error loading dashboard"
          description={
            error.message || "Failed to load dashboard data. Please try again."
          }
          action={
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      </DashboardErrorBoundary>
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
      {/* Show subtle loading indicator when refreshing. `isLoading` is false
          once data is cached, so a background refetch needs `isFetching`. */}
      {isFetching && dashboardData && (
        <div className="fixed top-4 right-4 bg-blue-500 text-white px-3 py-1 rounded-md text-sm z-50">
          Refreshing...
        </div>
      )}
      <HomeTab
        appointments={dashboardData.appointments}
        consultantId={consultantId}
        consultantName={consultantName}
        pendingRequestsCount={dashboardData.approvals?.length ?? 0}
        performanceSnapshot={dashboardData.performanceSnapshot}
        financialSummary={dashboardData.financialSummary}
      />
    </DashboardErrorBoundary>
  );
}
