import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";

/**
 * #1527 decision 6 — a suspended member keeps the sessions already booked, so
 * operators need to see them to cancel or refund deliberately. These are the
 * org's appointments whose attendee (requester or live seat holder) holds a
 * SUSPENDED membership in the org.
 */
export function suspendedMemberAttendeeWhere(
  orgId: string,
): Prisma.AppointmentWhereInput {
  const suspendedHere = {
    memberships: { some: { organizationId: orgId, status: "SUSPENDED" } },
  } satisfies Prisma.UserWhereInput;
  return {
    OR: [
      { consultation: { requestedBy: { user: suspendedHere } } },
      { subscription: { requestedBy: { user: suspendedHere } } },
      { participants: { some: { ...liveParticipant(), user: suspendedHere } } },
    ],
  };
}

/** How many of those still have a session ahead (the action-centre count). */
export async function countSuspendedMemberUpcomingSessions(
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  return prisma.appointment.count({
    where: {
      organizationId: orgId,
      deletedAt: null,
      occurrences: {
        some: {
          startsAt: { gte: now },
          deletedAt: null,
          hostCancelledAt: null,
          completionStatus: "SCHEDULED",
        },
      },
      AND: [suspendedMemberAttendeeWhere(orgId)],
    },
  });
}
