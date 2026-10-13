"use client";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/occurrences";
import type { TAppointment } from "@/types/appointment";
import { useConsultantAppointmentsAdapter } from "../ConsultantAppointmentsAdapter";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "../utils/participantHelpers";

export default function DetailPageClient({
  consultantId,
  appointmentId,
}: Readonly<{ consultantId: string; appointmentId: string }>) {
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
      resourceHrefs={{
        documents: `/dashboard/consultant/${consultantId}/appointments/${appointmentId}/documents`,
        recordings: `/dashboard/consultant/${consultantId}/appointments/${appointmentId}/recordings`,
      }}
      participantsHref={(detail) => {
        const appointment = detail.appointment as unknown as TAppointment;
        return supportsParticipantManagement(appointment)
          ? getParticipantManagementUrl(appointment, consultantId)
          : null;
      }}
    />
  );
}
