"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { useOrgScope } from "@/hooks/useOrgScope";
import {
  OrgContextFilter,
  ORG_FILTER_PERSONAL,
  ORG_FILTER_ALL,
  type OrgContextFilterValue,
} from "@/components/dashboard/OrgContextFilter";
import { RequestSlotAllocationTab } from "./RequestSlotAllocationTab";

/**
 * Requests tab page. RequestSlotAllocationTab owns its data: it resolves the
 * consultantId from the route via useParams and fetches the paginated
 * /api/events/consultations + /api/events/subscriptions endpoints with its
 * own loading/error states.
 *
 * Read-path scale fix: this page previously also ran the
 * /api/dashboard/consultant/[id]/requests query — the single heaviest
 * dashboard bundle (six unbounded datasets, 4-level includes) — purely to
 * gate rendering on isLoading/error; the response data was never read
 * anywhere. The endpoint is deleted and the tab renders immediately,
 * removing the double loading phase.
 */
export default function RequestsPage() {
  // S1 (B1-personal-retrofit): the OrgContextFilter dropdown lets a
  // consultant who works for multiple orgs toggle between "Personal" /
  // "<org>" / "All" (drives the ?orgScope= URL param via useOrgScope).
  // Self-hides for consultants with zero org memberships. Note: the tab's
  // /api/events/* fetches don't consume orgScope yet — wiring the scope
  // into those endpoints is tracked follow-up work, not a regression of
  // this page (the deleted query was the only thing that ever read it,
  // and its data went nowhere).
  const { scope, setScope } = useOrgScope();

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
