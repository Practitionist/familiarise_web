"use client";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { DeliverableThreadList } from "@/components/documents/DeliverableThreadList";
import { isConfirmedStatus } from "@/lib/appointments/status";
import { supportsDocuments } from "@/lib/appointments/kind-capabilities";
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
      renderDocuments={(vm) => {
        if (!supportsDocuments(vm.kind)) return null;
        const canUpload = isConfirmedStatus(vm.status);

        return (
          <DeliverableThreadList
            appointmentId={appointmentId}
            viewerRole="consultant"
            canUpload={canUpload}
          />
        );
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
