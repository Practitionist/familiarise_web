import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

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

/**
 * #1527 decision 6 — a suspended member keeps read + join on sessions already
 * booked, but may not cancel or reschedule an org-funded one (the org decides
 * refunds deliberately). The lifecycle routes refuse with this typed 403
 * before any quote or refund logic runs.
 */
export const MEMBERSHIP_SUSPENDED = "MEMBERSHIP_SUSPENDED" as const;

export const MEMBERSHIP_SUSPENDED_MESSAGE =
  "Your membership of the organisation that booked this session is suspended. You can still join it, but only the organisation can cancel or reschedule it.";

/** Whether `userId` holds a SUSPENDED membership in the funding org. */
export async function isSuspendedInFundingOrg(
  userId: string,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { status: true },
  });
  return membership?.status === "SUSPENDED";
}

/** Throwable form for routes whose catch maps `httpStatus` + `code`. */
export function membershipSuspendedError(): Error & {
  httpStatus: 403;
  code: typeof MEMBERSHIP_SUSPENDED;
} {
  return Object.assign(new Error(MEMBERSHIP_SUSPENDED_MESSAGE), {
    httpStatus: 403 as const,
    code: MEMBERSHIP_SUSPENDED,
  });
}

export function membershipSuspendedResponse(): NextResponse {
  return NextResponse.json(
    { error: MEMBERSHIP_SUSPENDED_MESSAGE, code: MEMBERSHIP_SUSPENDED },
    { status: 403 },
  );
}
