"use client";

import { useParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
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
  const { data: plannerData, isLoading, error } = useQuery({
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

  if (isLoading) {
    return <PlannerSkeleton />;
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
      <div className="mb-4 flex justify-end">
        <OrgContextFilter value={filterValue} onChange={handleFilterChange} />
      </div>
      <EventManagementDashboard
        consultantId={consultantId}
        initialData={plannerData}
      />
    </DashboardErrorBoundary>
  );
}
