/**
 * #1771 K-6 — what the Class-series tab shows for one class: the series
 * ledger, the host-cancelled sessions and their make-ups, the reliability
 * flag, and every seat with its own ledger. Read-only; the doors live in
 * app/api/admin/class-series.
 */

import prisma from "@/lib/prisma";
import { seatLedgerFrom, seriesLedgerFrom } from "@/lib/booking/class-series";
import { fundingRailForIntent } from "@/lib/payments/operations/booking-refund";
import type { ClassSeriesView } from "./class-series-types";

export type { ClassSeriesView };

export const reliabilityCorrelationId = (classId: string) =>
  `class-reliability:${classId}`;

export async function listClassesForPicker(query: string) {
  const q = query.trim();
  const rows = await prisma.class.findMany({
    where: {
      deletedAt: null,
      ...(q
        ? {
            OR: [
              { id: q },
              { classPlan: { title: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      status: true,
      classPlan: {
        select: {
          title: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    status: c.status,
    title: c.classPlan.title,
    hostName: c.classPlan.consultantProfile?.user.name ?? null,
  }));
}

const OCC_SELECT = {
  id: true,
  ordinal: true,
  startsAt: true,
  endsAt: true,
  completionStatus: true,
  movedAt: true,
  hostCancelledAt: true,
  seatsSettledAt: true,
  deletedAt: true,
} as const;

export async function readClassSeries(
  classId: string,
): Promise<ClassSeriesView | null> {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    select: {
      id: true,
      status: true,
      classPlan: { select: { title: true, totalSessions: true } },
      appointment: { select: { id: true } },
    },
  });
  const appointmentId = cls?.appointment?.id;
  if (!cls || !appointmentId) return null;
  const now = new Date();
  const all = await prisma.appointmentOccurrence.findMany({
    where: { appointmentId, isTentative: false },
    orderBy: { startsAt: "asc" },
    select: OCC_SELECT,
  });
  const live = all.filter((o) => !o.deletedAt);
  const N = cls.classPlan.totalSessions || live.length;
  const flag = await prisma.systemEvent.findFirst({
    where: { correlationId: reliabilityCorrelationId(classId) },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, context: true },
  });
  const cleared =
    (flag?.context as { cleared?: unknown } | null)?.cleared === true;

  return {
    classId,
    appointmentId,
    title: cls.classPlan.title,
    status: cls.status,
    series: seriesLedgerFrom({ N, occurrences: live, now }),
    reliability: {
      active: !!flag && !cleared,
      since: flag && !cleared ? flag.createdAt.toISOString() : null,
    },
    upcoming: live
      .filter((o) => o.completionStatus === "SCHEDULED" && o.startsAt > now)
      .map((o) => ({
        id: o.id,
        ordinal: o.ordinal,
        startsAt: o.startsAt.toISOString(),
      })),
    cancelledSessions: live
      .filter((o) => o.hostCancelledAt)
      .map((o) => {
        const makeUp = live.find(
          (m) =>
            m.ordinal === o.ordinal &&
            m.id !== o.id &&
            m.completionStatus !== "CANCELLED",
        );
        return {
          id: o.id,
          ordinal: o.ordinal,
          startsAt: o.startsAt.toISOString(),
          hostCancelledAt: (o.hostCancelledAt as Date).toISOString(),
          seatsSettledAt: o.seatsSettledAt?.toISOString() ?? null,
          makeUp: makeUp
            ? { id: makeUp.id, startsAt: makeUp.startsAt.toISOString() }
            : null,
        };
      }),
    seats: await readSeats(appointmentId, N, live, now),
  };
}

/** A credit seat's value is the credit it consumed, not its ₹0 amount. */
function seatValuePaise(
  pay: {
    amount: number | bigint;
    creditUsages: { originalAmount: number | bigint }[];
  } | null,
  rail: string | null,
): number {
  if (!pay) return 0;
  if (rail !== "CREDITS") return Number(pay.amount);
  return pay.creditUsages.reduce((s, u) => s + Number(u.originalAmount), 0);
}

async function readSeats(
  appointmentId: string,
  N: number,
  live: Parameters<typeof seatLedgerFrom>[0]["occurrences"],
  now: Date,
): Promise<ClassSeriesView["seats"]> {
  const participants = await prisma.appointmentParticipant.findMany({
    where: { appointmentId, role: "CONSULTEE" },
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      status: true,
      createdAt: true,
      user: { select: { name: true } },
      payment: {
        select: {
          id: true,
          amount: true,
          paymentIntent: true,
          createdAt: true,
          creditUsages: { select: { originalAmount: true } },
          refunds: {
            where: {
              status: { in: ["SUCCEEDED", "PENDING"] },
              dedupeKey: { startsWith: "occ:" },
            },
            select: { amountPaise: true },
          },
        },
      },
    },
  });
  return participants.map((p) => {
    const pay = p.payment;
    const rail = pay ? fundingRailForIntent(pay.paymentIntent) : null;
    const valuePaise = seatValuePaise(pay, rail);
    const joinedAt =
      pay && pay.createdAt > p.createdAt ? pay.createdAt : p.createdAt;
    const ledger = seatLedgerFrom({
      N,
      amountPaise: valuePaise,
      joinedAt,
      occurrences: live,
      now,
    });
    return {
      userId: p.userId,
      name: p.user.name,
      status: p.status,
      paymentId: pay?.id ?? null,
      rail,
      valuePaise,
      unitPaise: Number(ledger.unitPaise),
      delivered: ledger.deliveredHeld,
      held: ledger.heldCount,
      occRefundedPaise:
        pay?.refunds.reduce((s, r) => s + Number(r.amountPaise), 0) ?? 0,
    };
  });
}
