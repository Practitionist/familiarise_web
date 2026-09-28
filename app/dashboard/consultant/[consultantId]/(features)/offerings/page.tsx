"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { EventManagementDashboard } from "@/components/planner/components/EventManagementDashboard";
import { NewOfferingMenu } from "@/components/offerings/list/NewOfferingMenu";
import { OfferingsTabs } from "@/components/offerings/list/OfferingsTabs";

/**
 * /offerings — the Event Planner renamed and redesigned (#1527 §7.2). The
 * webinar/class instances come from the planner read; the 1:1 plan lists and
 * the per-offering stats load inside the list.
 */
export default function OfferingsPage() {
  const consultantId = useParams().consultantId as string;

  // keepPreviousData: a refetch keeps the cards instead of flashing a
  // skeleton (documents-page idiom, #346).
  const {
    data: plannerData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...createConsultantQueries(consultantId).planner,
    placeholderData: keepPreviousData,
  });

  let body: ReactNode;
  if (isLoading && !plannerData) {
    body = <PlannerSkeleton />;
  } else if (error || !plannerData) {
    body = (
      <ErrorState
        title="Couldn't load your offerings"
        description="Your webinars and classes didn't load. Try again."
        onRetry={() => void refetch()}
      />
    );
  } else {
    body = (
      <DashboardErrorBoundary>
        <EventManagementDashboard
          consultantId={consultantId}
          data={plannerData}
        />
      </DashboardErrorBoundary>
    );
  }

  return (
    <>
      <DashboardHeader
        title="Offerings"
        description="What you sell, and the webinars and classes you deliver with others"
        actions={<NewOfferingMenu consultantId={consultantId} />}
      />
      <OfferingsTabs consultantId={consultantId} />
      <DashboardContent>{body}</DashboardContent>
    </>
  );
}
