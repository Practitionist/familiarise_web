"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard";
import { createConsulteeQueries } from "@/hooks/useConsulteePrefetchDashboard";
import FeedbackSupportTab from "./FeedbackSupportTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function FeedbackPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  // Use the centralized query configurations
  const consulteeQueries = createConsulteeQueries(consulteeId);
  const {
    data: feedbacks,
    isLoading: feedbackLoading,
    error: feedbackError,
  } = useQuery(consulteeQueries.feedback);

  const {
    data: tickets,
    isLoading: ticketsLoading,
    error: ticketsError,
  } = useQuery(consulteeQueries.supportTickets);

  const isLoading = feedbackLoading || ticketsLoading;
  const error = feedbackError || ticketsError;

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Feedback</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load feedback data. Please try again."}
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
      <FeedbackSupportTab consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}
