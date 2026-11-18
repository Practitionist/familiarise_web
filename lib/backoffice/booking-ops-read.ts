/**
 * #1771 — what the per-booking Ops actions panel shows: the booking's live
 * sessions with their outcome, and its payments with what was refunded.
 * Read-only; the doors it opens are the existing console routes.
 */

import prisma from "@/lib/prisma";
import { RELEASED_PARTICIPANT_STATUSES } from "@/lib/booking/participants";
import {
  readSeatTrails,
  REJOIN_OPENING_REASONS,
} from "@/lib/booking/seat-history";
import { lastRemovalKind } from "@/lib/booking/seat-trail-copy";
import { isPriceFreePayment } from "@/lib/payments/funding-rail";
import { CONDUCT_REMOVAL_CATEGORY } from "@/lib/support/case-topic";
import { conductRemovalStands } from "@/lib/support/conduct-removal-state";
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
      participants: {
        where: {
          role: "CONSULTEE",
          status: { in: RELEASED_PARTICIPANT_STATUSES },
        },
        select: {
          id: true,
          user: { select: { id: true, name: true } },
          removedByUserId: true,
          payment: {
            select: { paymentIntent: true, amount: true, originalAmount: true },
          },
        },
      },
    },
  });
  if (!appt) return null;
  const trails = await readSeatTrails(
    prisma,
    appt.participants.map((seat) => seat.id),
  );
  const conductStanding = await unmarkedConductRemovals(
    appt.id,
    appt.participants
      .filter((seat) => !seat.removedByUserId)
      .map((seat) => seat.user.id),
  );
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
    removedSeats: appt.participants.flatMap((seat) => {
      const trail = trails.get(seat.id) ?? [];
      const priceFree =
        !!seat.payment &&
        isPriceFreePayment({
          paymentIntent: seat.payment.paymentIntent,
          amountPaise: Number(seat.payment.amount),
          listPricePaise: Number(seat.payment.originalAmount),
        });
      const conduct = conductStanding.has(seat.user.id);
      if (!seat.removedByUserId && !conduct) {
        // An unmarked free seat with no recorded leave or lift waits for a staff lift.
        const latest = trail.at(-1)?.reason;
        const opened =
          latest !== undefined && REJOIN_OPENING_REASONS.includes(latest);
        if (opened || !priceFree) return [];
      }
      let removal: "ORGANISER" | "CONDUCT" | "LEGACY" = "LEGACY";
      if (conduct) removal = "CONDUCT";
      else if (seat.removedByUserId) removal = lastRemovalKind(trail);
      return [
        {
          userId: seat.user.id,
          name: seat.user.name,
          removal,
          paidSeat: !priceFree,
        },
      ];
    }),
  };
}

/**
 * Learners on unmarked seats whose conduct removal still stands (one from before
 * the mark existed), by the same rule the lift and the call block read.
 */
async function unmarkedConductRemovals(
  appointmentId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const cases = await prisma.supportCase.findMany({
    where: {
      appointmentId,
      category: CONDUCT_REMOVAL_CATEGORY,
      deletedAt: null,
      requesterUserId: { in: userIds },
    },
    select: { requesterUserId: true },
    distinct: ["requesterUserId"],
  });
  const standing = new Set<string>();
  for (const { requesterUserId } of cases) {
    if (await conductRemovalStands(appointmentId, requesterUserId)) {
      standing.add(requesterUserId);
    }
  }
  return standing;
}

function sumRefunds(
  refunds: { amountPaise: bigint | number; status: string }[],
  status: string,
): number {
  return refunds
    .filter((r) => r.status === status)
    .reduce((sum, r) => sum + Number(r.amountPaise), 0);
}
