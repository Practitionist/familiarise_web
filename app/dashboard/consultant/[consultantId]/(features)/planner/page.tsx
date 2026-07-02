"use client";

import { useParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/DashboardShell";
import { EmptyState } from "@/components/dashboard/DataCard";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_PERSONAL,
  ORG_FILTER_ALL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { EventManagementDashboard } from "./components/EventManagementDashboard";

export default function PlannerPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;

  // S1 (B1-personal-retrofit): scope-toggle dropdown above the planner.
  // The retrofitted /api/dashboard/consultant/[id]/planner accepts
  // ?orgScope= and filters webinars/classes by their parent
  // appointment.organizationId. Self-hides for consultants with zero
  // org memberships.
  const { scope, setScope } = useOrgScope();
  // "all" sends `?orgScope=all` to the API. Self-scoped consultant
  // endpoints opt in via allowAllForOwner — returns personal + every
  // org the user belongs to.
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;
  const plannerQuery = createConsultantQueries(consultantId, orgScopeParam)
    .planner;
  // keepPreviousData: scope-filter changes show the previous planner while
  // the new one loads instead of a skeleton flash (documents-page idiom, #346).
  const {
    data: plannerData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...plannerQuery,
    placeholderData: keepPreviousData,
  });

  const filterValue: OrgContextFilterValue =
    scope.kind === "personal"
      ? ORG_FILTER_PERSONAL
      : scope.kind === "all"
        ? ORG_FILTER_ALL
        : scope.orgId;
  const handleFilterChange = (next: OrgContextFilterValue) => {
    if (next === ORG_FILTER_PERSONAL) setScope({ kind: "personal" });
    else if (next === ORG_FILTER_ALL) setScope({ kind: "all" });
    else setScope({ kind: "org", orgId: next });
  };

  const header = (
    <DashboardHeader
      title="Event Planner"
      subtitle="Create and manage your plans and scheduled sessions"
      actions={
        <OrgContextFilter value={filterValue} onChange={handleFilterChange} />
      }
    />
  );

  if (isLoading) {
    return (
      <>
        {header}
        <DashboardContent>
          <PlannerSkeleton />
        </DashboardContent>
      </>
    );
  }

  if (error || !plannerData) {
    return (
      <>
        {header}
        <DashboardContent>
          <DashboardErrorBoundary>
            <EmptyState
              icon={CalendarRange}
              title={error ? "Couldn't load your planner" : "No planner data"}
              description={
                error instanceof Error
                  ? error.message
                  : "Planner data is unavailable right now. Please retry."
              }
              action={
                <Button variant="outline" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          </DashboardErrorBoundary>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      {header}
      <DashboardContent>
        <DashboardErrorBoundary>
          <EventManagementDashboard
            consultantId={consultantId}
            data={plannerData}
          />
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
