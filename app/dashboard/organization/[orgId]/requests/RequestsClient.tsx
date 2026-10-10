"use client";

import { RequestsInbox } from "@/components/dashboard/shared/requests/RequestsInbox";

/**
 * Organization Requests inbox: mounts the shared RequestsInbox scoped to one
 * organization via `?orgScope=<orgId>` — personal bookings reads exclude
 * org-funded rows when that param is absent.
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
    <RequestsInbox consultantProfileId={consultantProfileId} orgScope={orgId} />
  );
}
