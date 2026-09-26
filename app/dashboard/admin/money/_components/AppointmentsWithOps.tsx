"use client";

import { OperatorAppointmentsClient } from "@/components/dashboard/shared/OperatorAppointmentsClient";
import { BookingOpsPanel } from "./BookingOpsPanel";
import { SessionOutcomesCard } from "./SessionOutcomesCard";

/**
 * #1771 — the Appointments page of either tree with its Ops actions: the
 * sessions-needing-a-decision queue on top, and each booking's panel in its
 * detail dialog. The staff tree shows staff doors even to an admin.
 */
export function AppointmentsWithOps({
  tree,
  treePath,
}: Readonly<{ tree: "admin" | "staff"; treePath: string }>) {
  return (
    <>
      <div className="mb-6">
        <SessionOutcomesCard />
      </div>
      <OperatorAppointmentsClient
        renderOps={(appointmentId) => (
          <BookingOpsPanel
            appointmentId={appointmentId}
            isAdmin={tree === "admin"}
            treePath={treePath}
          />
        )}
      />
    </>
  );
}
