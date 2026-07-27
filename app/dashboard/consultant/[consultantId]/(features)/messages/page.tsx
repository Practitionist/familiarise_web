"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { ChatSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { MessagesTab } from "./MessagesTab";

export default function ChatsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

  // Use the centralized query configuration
  const detailsQuery = createConsultantQueries(consultantId).details;
  const {
    data: consultantDetails,
    isLoading,
    error,
    refetch,
  } = useQuery(detailsQuery);

  if (isLoading) {
    return <ChatSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <EmptyState
          icon={AlertCircle}
          title="Error loading chat data"
          description={
            error.message ||
            "Failed to load consultant details for chat. Please try again."
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

  if (!consultantDetails?.user) {
    return (
      <DashboardErrorBoundary>
        <EmptyState
          icon={AlertCircle}
          title="User data not found"
          description="User details not found for the given consultant ID."
        />
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <MessagesTab
        userId={consultantDetails.user.id}
        userRole={consultantDetails.user.role}
      />
    </DashboardErrorBoundary>
  );
}
