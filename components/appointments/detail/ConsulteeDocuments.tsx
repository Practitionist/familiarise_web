"use client";

import { DeliverableThreadList } from "@/components/documents/DeliverableThreadList";
import { supportsDocuments } from "@/lib/appointments/kind-capabilities";
import {
  isCompletedLikeStatus,
  isConfirmedStatus,
} from "@/lib/appointments/status";
import type { AppointmentVM } from "@/lib/appointments/view-model";

export function ConsulteeDocuments({
  vm,
  appointmentId,
}: Readonly<{ vm: AppointmentVM; appointmentId: string }>) {
  if (!supportsDocuments(vm.kind)) return null;

  if (isConfirmedStatus(vm.status) || isCompletedLikeStatus(vm.status)) {
    return (
      <DeliverableThreadList
        appointmentId={appointmentId}
        viewerRole="consultee"
        canUpload={isConfirmedStatus(vm.status)}
      />
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      Documents can be shared once the booking is confirmed.
    </p>
  );
}
