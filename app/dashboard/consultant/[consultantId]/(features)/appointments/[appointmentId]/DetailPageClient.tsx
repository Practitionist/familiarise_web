"use client";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";
import type { TAppointment } from "@/types/appointment";
import { useConsultantAppointmentsAdapter } from "../ConsultantAppointmentsAdapter";
import { getParticipantManagementUrl } from "../utils/participantHelpers";

export default function DetailPageClient({
  consultantId,
  appointmentId,
  operatorView,
}: Readonly<{
  consultantId: string;
  appointmentId: string;
  /** Staff viewing this expert's booking. */
  operatorView: boolean;
}>) {
  const adapter = useConsultantAppointmentsAdapter(consultantId);

  return (
    <AppointmentDetailClient
      appointmentId={appointmentId}
      role="consultant"
      adapter={adapter}
      backHref={`/dashboard/consultant/${consultantId}/appointments`}
      supportRequestsBase={`/dashboard/consultant/${consultantId}/support/requests`}
      joinWindowMs={CONSULTANT_JOIN_WINDOW_MS}
      consultantId={consultantId}
      operatorView={operatorView}
      resourceHrefs={{
        documents: `/dashboard/consultant/${consultantId}/appointments/${appointmentId}/documents`,
        recordings: `/dashboard/consultant/${consultantId}/appointments/${appointmentId}/recordings`,
      }}
      participantsHref={(detail) => {
        const appointment = detail.appointment as unknown as TAppointment;
        return getParticipantManagementUrl(appointment, consultantId);
      }}
    />
  );
}
