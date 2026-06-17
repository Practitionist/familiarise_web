"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
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
    error,
    isStale: _isStale,
  } = useQuery<TConsultantDashboardResponse>(dashboardQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !dashboardData) {
    return <HomeSkeleton />;
  }

  if (error && !dashboardData) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Dashboard</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load dashboard data. Please try again."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  if (!dashboardData) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-orange-50 text-orange-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">No Data Available</h3>
            <p className="text-sm">
              Dashboard data not found for this consultant.
            </p>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      {/* Show subtle loading indicator when refreshing */}
      {isLoading && dashboardData && (
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
