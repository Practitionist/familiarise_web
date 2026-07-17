import prisma from "@/lib/prisma";
import { TERMINAL_DISPUTE_STATUSES } from "./dispute-status";

/**
 * #1008 — true when a non-terminal (live) dispute exists on any payment for the
 * appointment. Callers block state mutations (cancel / reschedule) while a
 * dispute is contested: the appointment is evidence, and a cancel-driven refund
 * would double-pay against a gateway chargeback that may still land.
 *
 * Served by Dispute(paymentId,status) + Payment(appointmentId) indexes. No
 * admin bypass in v1 — TODO(#1008): allow an explicit privileged override.
 */
export async function hasActiveDisputeForAppointment(
  appointmentId: string,
): Promise<boolean> {
  const dispute = await prisma.dispute.findFirst({
    where: {
      payment: { appointmentId },
      status: { notIn: TERMINAL_DISPUTE_STATUSES },
    },
    select: { id: true },
  });
  return dispute !== null;
}
