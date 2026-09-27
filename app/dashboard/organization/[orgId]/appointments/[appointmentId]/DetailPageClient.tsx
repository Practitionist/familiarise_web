"use client";

import { useMemo } from "react";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { readOnlyAdapter } from "@/lib/appointments/adapter";
import { ConsulteeDocuments } from "@/components/appointments/detail/ConsulteeDocuments";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { CONSULTEE_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";

/**
 * Detail view for one of the member's own org-funded sessions.
 *
 * The org appointment list previously offered a single action — Join, and only
 * inside the join window. It named your counterpart and gave you no way to
 * reach them, reschedule, cancel, or hand over a document; every one of those
 * meant switching to the personal dashboard, for a session the organization
 * paid for. ADR 19 puts org-funded work in the org dashboard, so the actions
 * belong here too.
 *
 * Reuses the same `AppointmentDetailClient` and consultee adapter the B2C tree
 * mounts, which is what makes reschedule, cancel and report identical in both
 * places rather than a second implementation that drifts. Only `detailHref` is
 * overridden, so navigating within the detail view keeps the member inside the
 * org context instead of bouncing them to `/dashboard/consultee/...`.
 *
 * Reschedule still deep-links to the personal consultee reschedule heatmap
 * (no org-native picker yet), but carries a `returnTo` back to THIS page so
 * finishing or abandoning the flow no longer ejects the member into the
 * personal dashboard (#1166). `consulteeId` is passed from the SSR page
 * (already loaded for the participation check) because this URL has `orgId`,
 * not `consulteeId`.
 *
 * `role="consultee"` because this page is the ATTENDING side. An EXPERT
 * delivering org sessions manages them from Requests and their own tree; the
 * two roles want different actions on the same row, and conflating them behind
 * one page is how the appointments surfaces drifted before.
 */
export default function DetailPageClient({
  orgId,
  appointmentId,
  consulteeId,
  readOnly = false,
}: Readonly<{
  orgId: string;
  appointmentId: string;
  consulteeId: string;
  /** SUSPENDED membership: view and Join only (#1527 decision 6). */
  readOnly?: boolean;
}>) {
  const base = useConsulteeAppointmentsAdapter({
    consulteeId,
    rescheduleReturnTo: `/dashboard/organization/${orgId}/appointments/${appointmentId}`,
  });

  const adapter = useMemo(() => {
    const scoped = {
      ...base,
      detailHref: () =>
        `/dashboard/organization/${orgId}/appointments/${appointmentId}`,
    };
    return readOnly ? readOnlyAdapter(scoped) : scoped;
  }, [base, orgId, appointmentId, readOnly]);

  return (
    <AppointmentDetailClient
      appointmentId={appointmentId}
      role="consultee"
      adapter={adapter}
      backHref={`/dashboard/organization/${orgId}/appointments`}
      supportRequestsBase={`/dashboard/organization/${orgId}/support/requests`}
      joinWindowMs={CONSULTEE_JOIN_WINDOW_MS}
      renderDocuments={(vm) => (
        <ConsulteeDocuments vm={vm} appointmentId={appointmentId} />
      )}
    />
  );
}
