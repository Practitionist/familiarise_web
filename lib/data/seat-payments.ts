/**
 * Server-side reads for the roster's per-seat payment column. Separate from
 * lib/appointments/seat-payments.ts, which the detail client imports and
 * which therefore cannot touch Prisma (prisma → pg → fs breaks the build).
 */

import prisma from "@/lib/prisma";
import {
  paymentDisplayStatus,
  seatPaymentsByUser,
} from "@/lib/appointments/seat-payments";

export type SeatPaymentWire = {
  userId: string;
  /** The DISPLAY status — REFUNDED / PARTIALLY_REFUNDED are derived. */
  paymentStatus: string;
  /** Paise as a string — the row holds a BigInt. */
  amount: string;
  currency: string;
};

/** The best Payment per seat across an event's appointments, serialised. */
export async function readSeatPayments(
  appointmentIds: string[],
  userIds: string[],
): Promise<SeatPaymentWire[]> {
  if (appointmentIds.length === 0 || userIds.length === 0) return [];
  const rows = await prisma.payment.findMany({
    where: {
      appointmentId: { in: appointmentIds },
      userId: { in: userIds },
      deletedAt: null,
    },
    select: {
      userId: true,
      paymentStatus: true,
      amount: true,
      currency: true,
      createdAt: true,
      refunds: {
        where: { deletedAt: null, status: "SUCCEEDED" },
        select: { amountPaise: true },
      },
    },
  });
  return Array.from(seatPaymentsByUser(rows).values()).map((p) => ({
    userId: p.userId,
    paymentStatus: paymentDisplayStatus(p),
    amount: p.amount.toString(),
    currency: p.currency,
  }));
}
