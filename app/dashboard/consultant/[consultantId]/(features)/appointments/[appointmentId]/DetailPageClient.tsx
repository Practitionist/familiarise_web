"use client";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { AppointmentDocumentsList } from "@/components/appointments/detail/AppointmentDocumentsList";
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/slots";
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
    <>
      <AppointmentDetailClient
        appointmentId={appointmentId}
        role="consultant"
        adapter={adapter}
        backHref={`/dashboard/consultant/${consultantId}/appointments`}
        joinWindowMs={CONSULTANT_JOIN_WINDOW_MS}
        renderDocuments={() => (
          <AppointmentDocumentsList appointmentId={appointmentId} />
        )}
        participantsHref={(detail) => {
          const appointment = detail.appointment as unknown as TAppointment;
          return supportsParticipantManagement(appointment)
            ? getParticipantManagementUrl(appointment, consultantId)
            : null;
        }}
      />
      {/* Timings / schedule dialogs live on the adapter — must mount here too */}
      {adapter.renderDialogs()}
    </>
  );
}
