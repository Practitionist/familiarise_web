"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { RequestsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { RequestSlotAllocationTab } from "./RequestSlotAllocationTab";

export default function RequestsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

  // Use the centralized query configuration
  const requestsQuery = createConsultantQueries(consultantId).requests;
  const { data: _requestsData, isLoading, error } = useQuery(requestsQuery);

  if (isLoading) {
    return <RequestsSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Requests</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load requests data. Please try again."}
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

  const handleUpdate = () => {
    // Handled internally by RequestSlotAllocationTab
  };

  return (
    <DashboardErrorBoundary>
      <RequestSlotAllocationTab type="all" onUpdate={handleUpdate} />
    </DashboardErrorBoundary>
  );
}
