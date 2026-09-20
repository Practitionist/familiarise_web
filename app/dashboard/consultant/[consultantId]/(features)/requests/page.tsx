"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { RequestSchedulingTab } from "@/components/dashboard/shared/requests/RequestSchedulingTab";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useQuery } from "@tanstack/react-query";
import { PauseCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchConsultantData } from "../../utils/fetchHelpers";

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
  const params = useParams<{ consultantId: string }>();
  const consultantId = params?.consultantId ?? "";
  // #1703 D4 — same key and fetcher as Settings, so a save there is seen here.
  const { data: consultant } = useQuery({
    queryKey: ["consultant-settings", consultantId],
    queryFn: () => fetchConsultantData(consultantId),
    enabled: consultantId !== "",
    staleTime: 5 * 60 * 1000,
  });
  const paused = consultant?.acceptingRequests === false;

  const handleUpdate = () => {
    // Handled internally by RequestSchedulingTab
  };

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Requests"
        subtitle="Pending booking requests awaiting slot allocation"
      />
      {paused && (
        <Alert className="mt-6">
          <PauseCircle className="h-4 w-4" />
          <AlertDescription>
            You&apos;re not accepting new requests —{" "}
            <Link
              href={`/dashboard/consultant/${consultantId}/settings?tab=booking`}
              className="underline underline-offset-4"
            >
              turn it back on in Settings
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      <div className="pt-6">
        <RequestSchedulingTab type="all" onUpdate={handleUpdate} />
      </div>
    </DashboardErrorBoundary>
  );
}
