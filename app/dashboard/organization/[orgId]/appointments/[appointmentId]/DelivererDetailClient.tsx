"use client";

import { useMemo } from "react";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
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
}: Readonly<{
  orgId: string;
  appointmentId: string;
  consultantId: string;
}>) {
  const base = useConsultantAppointmentsAdapter(consultantId);
  const adapter = useMemo(
    () => ({
      ...base,
      detailHref: () =>
        `/dashboard/organization/${orgId}/appointments/${appointmentId}`,
    }),
    [base, orgId, appointmentId],
  );

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
