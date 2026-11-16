"use client";

import { OperatorAppointmentsClient } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { BookingOpsPanel } from "./BookingOpsPanel";
import { SessionOutcomesCard } from "./SessionOutcomesCard";
import { ExpertStrikesCard } from "./ExpertStrikesCard";

/**
 * The Appointments page of either tree with its Ops actions: the decision
 * queue (a row opens its booking) and the expert strike list on top, and each
 * booking's panel in its detail dialog. Each door reads the capability context.
 */
export function AppointmentsWithOps() {
  return (
    <OperatorAppointmentsClient
      beforeContent={(openBooking) => (
        <>
          <SessionOutcomesCard onOpenBooking={openBooking} />
          <ExpertStrikesCard />
        </>
      )}
      renderOps={(appointmentId) => (
        <BookingOpsPanel appointmentId={appointmentId} />
      )}
    />
  );
}
