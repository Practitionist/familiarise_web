"use client";

import { RequestsInbox } from "@/components/dashboard/shared/requests/RequestsInbox";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";

/**
 * This organisation's Requests inbox (#1775): the same component the
 * consultant tree mounts, pointed at one org through `?orgScope=<orgId>` —
 * the bookings reads exclude org-funded rows when that param is absent, which
 * is how an org-sponsored subscription once went paid and never scheduled.
 *
 * `consultantProfileId` is the VIEWER's delivering profile: allocation is a
 * delivery act, so the allocate links stay in the consultant tree. No RSC
 * seed here — this is already a client boundary and keeps its own loading.
 */
export function RequestsClient({
  orgId,
  consultantProfileId,
}: Readonly<{ orgId: string; consultantProfileId: string }>) {
  return (
    <DashboardErrorBoundary>
      <RequestsInbox
        consultantProfileId={consultantProfileId}
        orgScope={orgId}
      />
    </DashboardErrorBoundary>
  );
}
