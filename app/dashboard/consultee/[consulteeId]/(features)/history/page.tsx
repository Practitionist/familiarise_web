"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { TableSkeleton } from "@/components/dashboard";
import { createConsulteeQueries } from "@/hooks/useConsulteePrefetchDashboard";
import { BookingHistoryTab } from "./BookingHistoryTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
};

export default function HistoryPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  // Use the centralized query configuration
  const eventsQuery = createConsulteeQueries(consulteeId).events;
  const { data: eventsData, isLoading, error } = useQuery(eventsQuery);

  if (isLoading) {
    return <TableSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading History</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load booking history. Please try again."}
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
      <BookingHistoryTab
        consultations={eventsData?.consultations || []}
        subscriptions={eventsData?.subscriptions || []}
        webinars={eventsData?.webinars || []}
        classes={eventsData?.classes || []}
      />
    </DashboardErrorBoundary>
  );
}
