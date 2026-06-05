"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { RequestsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_PERSONAL,
  ORG_FILTER_ALL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { RequestSlotAllocationTab } from "./RequestSlotAllocationTab";

export default function RequestsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

  // S1 (B1-personal-retrofit): drive the requests query off the URL
  // ?orgScope= via useOrgScope. The OrgContextFilter dropdown above
  // the existing tab lets a consultant who works for multiple orgs
  // toggle between "Personal" / "<org>" / "All". Self-hides for
  // consultants with zero org memberships (no behavioral change there).
  const { scope, setScope } = useOrgScope();
  // "all" sends `?orgScope=all` to the API. This is now allowed for
  // owners of self-scoped endpoints (lib/api/scope/parse.ts —
  // allowAllForOwner). Returns personal + every org the user belongs to.
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;
  const requestsQuery = createConsultantQueries(consultantId, orgScopeParam)
    .requests;
  const { data: _requestsData, isLoading, error } = useQuery(requestsQuery);

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
    return <RequestsSkeleton />;
  }

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
            <h3 className="font-semibold mb-2">Error Loading Requests</h3>
            <p className="text-sm">
              {error.message ||
                "Failed to load requests data. Please try again."}
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

  const handleUpdate = () => {
    // Handled internally by RequestSlotAllocationTab
  };

  return (
    <DashboardErrorBoundary>
      <div className="mb-4 flex justify-end">
        <OrgContextFilter value={filterValue} onChange={handleFilterChange} />
      </div>
      <RequestSlotAllocationTab type="all" onUpdate={handleUpdate} />
    </DashboardErrorBoundary>
  );
}
