"use client";

import { useMemo } from "react";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { readOnlyAdapter } from "@/lib/appointments/adapter";
import { AppointmentDocumentsList } from "@/components/appointments/detail/AppointmentDocumentsList";
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";
import { useConsultantAppointmentsAdapter } from "@/app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter";

/**
 * The delivering expert's view of one org session (#1527 §7.3). Experts used
 * to 404 here because the page admitted only the attendee. Same detail client
 * and consultant adapter as the personal tree, so actions stay identical;
 * only `detailHref` is pinned to the org URL so navigating within the detail
 * keeps the expert in the org context.
 */
export function DelivererDetailClient({
  orgId,
  appointmentId,
  consultantId,
  readOnly = false,
}: Readonly<{
  orgId: string;
  appointmentId: string;
  consultantId: string;
  /** SUSPENDED membership: view and Join only (#1527 decision 6). */
  readOnly?: boolean;
}>) {
  const base = useConsultantAppointmentsAdapter(consultantId);
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
      role="consultant"
      adapter={adapter}
      backHref={`/dashboard/organization/${orgId}/appointments`}
      joinWindowMs={CONSULTANT_JOIN_WINDOW_MS}
      consultantId={consultantId}
      renderDocuments={() => (
        <AppointmentDocumentsList appointmentId={appointmentId} />
      )}
    />
  );
}
