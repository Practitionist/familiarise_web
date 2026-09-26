"use client";

import { OperatorAppointmentsClient } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { BookingOpsPanel } from "./BookingOpsPanel";
import { SessionOutcomesCard } from "./SessionOutcomesCard";

/**
 * #1771 — the Appointments page of either tree with its Ops actions: the
 * sessions-needing-a-decision queue on top, and each booking's panel in its
 * detail dialog. The staff tree shows staff doors even to an admin: each
 * door reads the capability context (#1527).
 */
export function AppointmentsWithOps() {
  return (
    <>
      <div className="mb-6">
        <SessionOutcomesCard />
      </div>
      <OperatorAppointmentsClient
        renderOps={(appointmentId) => (
          <BookingOpsPanel appointmentId={appointmentId} />
        )}
      />
    </>
  );
}
