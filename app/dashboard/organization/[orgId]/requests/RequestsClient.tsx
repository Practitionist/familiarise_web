"use client";

import { useState } from "react";

import { RequestSchedulingTab } from "@/components/dashboard/shared/requests/RequestSchedulingTab";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";

/**
 * Slot allocation for this organization's bookings.
 *
 * The same component the consultant tree mounts, pointed at one org. It reads
 * `?orgScope=<orgId>`, which is the whole fix: the bookings endpoints exclude
 * org-funded rows when that param is absent, and the only allocation surface in
 * the product used to sit in the consultant tree without it. An org-sponsored
 * subscription was therefore paid for and then never scheduled, because the
 * request to allocate its slots appeared nowhere anyone could act on it.
 *
 * `consultantProfileId` is passed explicitly because this route has no
 * `[consultantId]` param for the component's usual `useParams` fallback.
 */
export function RequestsClient({
  orgId,
  consultantProfileId,
}: Readonly<{ orgId: string; consultantProfileId: string }>) {
  // The component asks its parent to refresh; it owns its own data, so this is
  // the same no-op the consultant page passes.
  const [, setRefreshToken] = useState(0);

  return (
    <DashboardErrorBoundary>
      <RequestSchedulingTab
        type="all"
        onUpdate={() => setRefreshToken((n) => n + 1)}
        consultantProfileId={consultantProfileId}
        orgScope={orgId}
      />
    </DashboardErrorBoundary>
  );
}
