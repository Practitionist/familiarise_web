"use client";

import { AppointmentDocumentsList } from "@/components/appointments/detail/AppointmentDocumentsList";
import { DocumentUpload } from "@/components/appointments/DocumentUpload";
import { supportsDocuments } from "@/lib/appointments/kind-capabilities";
import {
  isCompletedLikeStatus,
  isConfirmedStatus,
} from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";

/**
 * The learner's documents block on a booking's detail page, shared by the
 * personal and the organization trees so a finished booking behaves the same
 * in both (#1527).
 */
export function ConsulteeDocuments({
  vm,
  appointmentId,
}: Readonly<{ vm: AppointmentVM; appointmentId: string }>) {
  if (!supportsDocuments(vm.kind)) return null;
  // #1527 P0 — a finished booking keeps its files: read-only, the learner's
  // uploads beside the expert's responses.
  if (isCompletedLikeStatus(vm.status)) {
    return (
      <AppointmentDocumentsList
        appointmentId={appointmentId}
        viewer="consultee"
      />
    );
  }
  if (isConfirmedStatus(vm.status)) {
    return (
      <DocumentUpload
        appointmentId={appointmentId}
        appointmentTitle={vm.title}
        appointmentType={vm.kind.charAt(0) + vm.kind.slice(1).toLowerCase()}
      />
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Documents can be shared once the booking is confirmed.
    </p>
  );
}
