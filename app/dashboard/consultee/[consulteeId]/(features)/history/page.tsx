"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHomeSkeleton } from "@/components/ui/dashboard-skeleton";
import { useConsulteeEvents } from "../../hooks/useConsulteeEvents";
import BookingHistoryTab from "./BookingHistoryTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function HistoryPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);
  const {
    data: eventsData,
    isLoading,
    error,
  } = useConsulteeEvents(consulteeId);

  if (isLoading) {
    return <DashboardHomeSkeleton />;
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

  const {
    consultations = [],
    subscriptions = [],
    webinars = [],
    classes = [],
  } = eventsData || {};

  return (
    <DashboardErrorBoundary>
      <BookingHistoryTab consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}
