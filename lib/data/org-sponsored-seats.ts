import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { LIVE_PARTICIPANT_STATUSES } from "@/lib/booking/participants";
import { ORG_FUNDED_PAYMENT_METHODS } from "@/lib/payments/org-funded";

/**
 * #1852 decision 3 — the sponsor view. A webinar or class hosted by someone
 * else can seat this org's members on this org's money. Appointments ›
 * Everyone lists those seats and nothing else: the member, the session title,
 * the date and whether they attended. It never names the other attendees, and
 * says nothing about the host beyond the session title (ADR 20: each org sees,
 * pays for and reports on only its own seats).
 *
 * Auth is enforced upstream (`operations.read` on the Everyone tab).
 */

/** A payment the org's own money made: tagged to the org and on one of its rails. */
export function orgFundedPaymentWhere(orgId: string): Prisma.PaymentWhereInput {
  return {
    organizationId: orgId,
    paymentMethod: { in: ORG_FUNDED_PAYMENT_METHODS },
  };
}

/**
 * #1854 (ADR 19) — a webinar or class seat carries the org only when the
 * org's money paid for it; a personal purchase by a member carries none, so
 * the sponsor view never shows it.
 */
export function seatPayerOrganizationId(
  organizationId: string | null,
  orgFunded: boolean,
): string | null {
  return orgFunded ? organizationId : null;
}

export function sponsoredSeatsWhere(
  orgId: string,
): Prisma.AppointmentParticipantWhereInput {
  return {
    organizationId: orgId,
    role: "CONSULTEE",
    status: { in: LIVE_PARTICIPANT_STATUSES },
    payment: orgFundedPaymentWhere(orgId),
    // Its own members only, including one it has since suspended.
    user: {
      memberships: {
        some: {
          organizationId: orgId,
          status: { in: ["ACTIVE", "SUSPENDED"] },
        },
      },
    },
    appointment: {
      deletedAt: null,
      appointmentType: { in: ["WEBINAR", "CLASS"] },
      // A session this org hosts is already on its own list, with its funded
      // attendees; this read covers the ones hosted elsewhere.
      OR: [{ organizationId: null }, { organizationId: { not: orgId } }],
    },
  };
}

/** Exactly what the sponsor sees about one seat, and nothing more. */
export interface SponsoredSeatRow {
  id: string;
  member: { name: string | null; email: string };
  sessionTitle: string;
  startsAt: string | null;
  attended: boolean;
}

const SEAT_SELECT = {
  id: true,
  userId: true,
  appointmentId: true,
  status: true,
  user: { select: { name: true, email: true } },
  appointment: {
    select: {
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      class: { select: { classPlan: { select: { title: true } } } },
      occurrences: {
        where: {
          deletedAt: null,
          completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
        },
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true },
      },
    },
  },
} satisfies Prisma.AppointmentParticipantSelect;

type SeatRecord = Prisma.AppointmentParticipantGetPayload<{
  select: typeof SEAT_SELECT;
}>;

export function toSponsoredSeatRow(
  seat: SeatRecord,
  attended: boolean,
): SponsoredSeatRow {
  const appt = seat.appointment;
  return {
    id: seat.id,
    member: { name: seat.user.name, email: seat.user.email },
    sessionTitle:
      appt.webinar?.webinarPlan.title ??
      appt.class?.classPlan.title ??
      "Group session",
    startsAt: appt.occurrences[0]?.startsAt.toISOString() ?? null,
    attended,
  };
}

export async function getOrgSponsoredGroupSeats(
  orgId: string,
  { page = 1, perPage = 20 }: { page?: number; perPage?: number } = {},
): Promise<{ items: SponsoredSeatRow[]; total: number }> {
  const where = sponsoredSeatsWhere(orgId);
  const [total, seats] = await prisma.$transaction([
    prisma.appointmentParticipant.count({ where }),
    prisma.appointmentParticipant.findMany({
      where,
      select: SEAT_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  // Attended = the seat was marked ATTENDED, or Stream's settled record of one
  // of the session's calls shows the member. Read only for these members on these sessions.
  const joined =
    seats.length === 0
      ? []
      : await prisma.meetingPresence.findMany({
          where: {
            meeting: { attendanceSettledAt: { not: null } },
            OR: seats.map((s) => ({
              userId: s.userId,
              occurrence: { appointmentId: s.appointmentId },
            })),
          },
          distinct: ["appointmentOccurrenceId", "userId"],
          select: {
            userId: true,
            occurrence: { select: { appointmentId: true } },
          },
        });
  const joinedKeys = new Set(
    joined.map((j) => `${j.occurrence.appointmentId}:${j.userId}`),
  );

  return {
    total,
    items: seats.map((s) =>
      toSponsoredSeatRow(
        s,
        s.status === "ATTENDED" ||
          joinedKeys.has(`${s.appointmentId}:${s.userId}`),
      ),
    ),
  };
}
