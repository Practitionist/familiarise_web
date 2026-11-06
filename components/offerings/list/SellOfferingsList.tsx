"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { EventManagementDashboard } from "@/components/planner/components/EventManagementDashboard";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import type { OfferingPlanType } from "@/lib/offerings/stats";

// 1:1 and subscription tabs list plans only; the planner read is group events.
const NO_GROUP_EVENTS = { webinars: [], classes: [], participantCounts: {} };

/** One Sell tab's plans; webinar and class instances come from the planner. */
export function SellOfferingsList({
  consultantId,
  type,
}: Readonly<{ consultantId: string; type: OfferingPlanType }>) {
  const group = type === "webinar" || type === "class";
  // Refetches keep current cards mounted instead of flashing a skeleton.
  const planner = useQuery({
    ...createConsultantQueries(consultantId).planner,
    placeholderData: keepPreviousData,
    enabled: group,
  });

  if (!group) {
    return (
      <EventManagementDashboard
        consultantId={consultantId}
        data={NO_GROUP_EVENTS}
        type={type}
      />
    );
  }
  if (planner.isLoading && !planner.data) return <PlannerSkeleton />;
  if (planner.error || !planner.data) {
    return (
      <ErrorState
        title="Couldn't load your programs"
        description="Your webinars and classes didn't load. Try again."
        onRetry={() => void planner.refetch()}
      />
    );
  }
  return (
    <EventManagementDashboard
      consultantId={consultantId}
      data={planner.data}
      type={type}
    />
  );
}
