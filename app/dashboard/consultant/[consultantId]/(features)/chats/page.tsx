"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";
import { useConsultantDetails } from "../../hooks/useConsultantDetails";
import { ChatsTab } from "./ChatsTab";

export default function ChatsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);
  const {
    data: consultantDetails,
    isLoading,
    error,
  } = useConsultantDetails(consultantId);

  if (isLoading) {
    return <DashboardHomeSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Chat Data</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load consultant details for chat. Please try again."}
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

  if (!consultantDetails?.user) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-orange-50 text-orange-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">User Data Not Found</h3>
            <p className="text-sm">
              User details not found for the given consultant ID.
            </p>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <ChatsTab
        userId={consultantDetails.user.id}
        userRole={consultantDetails.user.role}
      />
    </DashboardErrorBoundary>
  );
}
