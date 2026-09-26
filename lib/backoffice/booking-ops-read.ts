/**
 * #1771 — what the per-booking Ops actions panel shows: the booking's live
 * sessions with their outcome, and its payments with what was refunded.
 * Read-only; the doors it opens are the existing console routes.
 */

import prisma from "@/lib/prisma";
import type { BookingOpsView } from "./booking-ops-types";

export type { BookingOpsView };

const PAYMENTS_SHOWN = 20;

export async function readBookingOps(
  appointmentId: string,
): Promise<BookingOpsView | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      appointmentType: true,
      classId: true,
      subscriptionId: true,
      occurrences: {
        where: { deletedAt: null, isTentative: false },
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          ordinal: true,
          startsAt: true,
          endsAt: true,
          completionStatus: true,
          outcome: true,
        },
      },
      payment: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: PAYMENTS_SHOWN,
        select: {
          id: true,
          paymentStatus: true,
          amount: true,
          currency: true,
          refunds: {
            where: { status: { in: ["SUCCEEDED", "PENDING"] } },
            select: { amountPaise: true, status: true },
          },
        },
      },
    },
  });
  if (!appt) return null;
  return {
    appointmentId: appt.id,
    type: appt.appointmentType,
    classId: appt.classId,
    subscriptionId: appt.subscriptionId,
    sessions: appt.occurrences.map((o) => ({
      id: o.id,
      ordinal: o.ordinal,
      startsAt: o.startsAt.toISOString(),
      endsAt: o.endsAt.toISOString(),
      completionStatus: o.completionStatus,
      outcome: o.outcome,
    })),
    payments: appt.payment.map((p) => ({
      id: p.id,
      status: p.paymentStatus,
      amountPaise: Number(p.amount),
      currency: p.currency,
      // Only settled refunds read as refunded; PENDING is still in flight.
      refundedPaise: sumRefunds(p.refunds, "SUCCEEDED"),
      pendingRefundPaise: sumRefunds(p.refunds, "PENDING"),
    })),
  };
}

function sumRefunds(
  refunds: { amountPaise: bigint | number; status: string }[],
  status: string,
): number {
  return refunds
    .filter((r) => r.status === status)
    .reduce((sum, r) => sum + Number(r.amountPaise), 0);
}
