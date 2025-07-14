"use client";

import { useParams } from "next/navigation";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";
import { usePlanner } from "../../hooks/usePlanner";
import { EventManagementDashboard } from "./components/EventManagementDashboard";

export default function PlannerPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;

  const { data: plannerData, isLoading, error } = usePlanner(consultantId);

  if (isLoading) {
    return <DashboardHomeSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Planner</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load planner data. Please try again."}
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

  if (!plannerData) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-orange-50 text-orange-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">No Data Available</h3>
            <p className="text-sm">
              Planner data not found for this consultant.
            </p>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <EventManagementDashboard
        consultantId={consultantId}
        initialData={plannerData}
      />
    </DashboardErrorBoundary>
  );
}
