"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/DashboardShell";
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
 * /api/bookings/consultations + /api/bookings/subscriptions endpoints with its
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
  // The OrgContextFilter dropdown lets a consultant who works for multiple
  // orgs toggle between "Personal" / "<org>" / "All". The resolved scope is
  // threaded into the tab's /api/bookings/* fetches as ?orgScope= (filtered
  // server-side via the denormalized Appointment.organizationId) — the
  // dropdown used to be a documented no-op here. Org members default to
  // "All activity" so panel experts land on the union view, matching the
  // appointments page.
  const { scope, setScope } = useOrgScope({ defaultForOrgMember: "all" });
  const orgScopeParam =
    scope.kind === "personal"
      ? "personal"
      : scope.kind === "all"
        ? "all"
        : scope.orgId;

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
      <DashboardHeader
        title="Requests"
        subtitle="Pending booking requests awaiting slot allocation"
        actions={
          <OrgContextFilter value={filterValue} onChange={handleFilterChange} />
        }
      />
      <div className="pt-6">
        <RequestSlotAllocationTab
          type="all"
          onUpdate={handleUpdate}
          orgScope={orgScopeParam}
        />
      </div>
    </DashboardErrorBoundary>
  );
}
