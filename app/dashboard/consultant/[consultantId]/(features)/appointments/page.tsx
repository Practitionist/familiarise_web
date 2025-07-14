"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";
import { useAppointments } from "../../hooks/useAppointments";
import { BADGE_STYLES } from "../../types";
import { AppointmentsTab } from "./AppointmentsTab";

export default function AppointmentsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);
  const {
    data: appointments,
    isLoading,
    error,
  } = useAppointments(consultantId);

  if (isLoading) {
    return <DashboardHomeSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Appointments</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load appointments. Please try again."}
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

  return (
    <DashboardErrorBoundary>
      <AppointmentsTab
        appointments={appointments || []}
        badgeStyles={BADGE_STYLES}
      />
    </DashboardErrorBoundary>
  );
}
