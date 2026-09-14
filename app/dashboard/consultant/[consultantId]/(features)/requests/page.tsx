"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { RequestSchedulingTab } from "@/components/dashboard/shared/requests/RequestSchedulingTab";

/**
 * Requests tab page. RequestSchedulingTab owns its data: it resolves the
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
  const handleUpdate = () => {
    // Handled internally by RequestSchedulingTab
  };

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Requests"
        subtitle="Pending booking requests awaiting slot allocation"
      />
      <div className="pt-6">
        <RequestSchedulingTab type="all" onUpdate={handleUpdate} />
      </div>
    </DashboardErrorBoundary>
  );
}
