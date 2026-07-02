"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import FeedbackSupportTab from "./FeedbackSupportTab";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { LifeBuoy } from "lucide-react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function FeedbackPage({ params }: Readonly<PageProps>) {
  const { consulteeId } = use(params);

  // These are the SAME query configs useFeedbackSupport consumes inside the
  // tab — one fetch pair per page load, shared through the query cache.
  const consulteeQueries = createConsulteeQueries(consulteeId);
  const {
    isLoading: feedbackLoading,
    error: feedbackError,
    refetch: refetchFeedback,
  } = useQuery(consulteeQueries.feedback);

  const {
    isLoading: ticketsLoading,
    error: ticketsError,
    refetch: refetchTickets,
  } = useQuery(consulteeQueries.supportTickets);

  const isLoading = feedbackLoading || ticketsLoading;
  const error = feedbackError || ticketsError;

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (error) {
    return (
      <EmptyState
        icon={LifeBuoy}
        title="Couldn't load feedback & support"
        description={
          error.message || "Failed to load feedback data. Please try again."
        }
        action={
          <Button
            variant="outline"
            onClick={() => {
              void refetchFeedback();
              void refetchTickets();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <DashboardErrorBoundary>
      <FeedbackSupportTab consulteeId={consulteeId} />
    </DashboardErrorBoundary>
  );
}
