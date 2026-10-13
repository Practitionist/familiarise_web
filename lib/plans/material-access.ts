import type { AppointmentStatus, Prisma } from "@prisma/client";

/**
 * Who may open a plan material: the plan's owner, its accepted co-hosts, org
 * operators who manage the plan's materials, and learners on a paid booking.
 * Every material list and the open routes use these arms, so a listed file can
 * always be opened and an unpaid booking never reaches one.
 */

/** Paid, accepted request states; anything else (requested, awaiting payment, closed) is not a buyer. */
export const PAID_REQUEST_STATUSES: AppointmentStatus[] = [
  "APPROVED",
  "SCHEDULED",
  "COMPLETED",
];

const LIVE_SEAT_STATUSES = ["CONFIRMED", "ATTENDED"] as const;

/** Materials a learner reaches through their own paid bookings. */
export function learnerMaterialWhere(
  userId: string,
): Prisma.PlanMaterialWhereInput {
  const paidRequest = {
    requestedBy: { userId },
    status: { in: PAID_REQUEST_STATUSES },
    appointment: { is: { deletedAt: null } },
  };
  const paidSeat = {
    status: { not: "CANCELLED" as const },
    appointment: {
      is: {
        deletedAt: null,
        participants: {
          some: { userId, status: { in: [...LIVE_SEAT_STATUSES] } },
        },
      },
    },
  };
  return {
    OR: [
      { consultationPlan: { consultations: { some: paidRequest } } },
      { subscriptionPlan: { subscriptions: { some: paidRequest } } },
      { webinarPlan: { webinars: { some: paidSeat } } },
      { classPlan: { classes: { some: paidSeat } } },
    ],
  };
}

/** Materials a host reaches as the plan's owner or an accepted co-host. */
export function hostMaterialWhere(
  userId: string,
): Prisma.PlanMaterialWhereInput {
  const owns = { consultantProfile: { userId } };
  const cohost = {
    collaborators: {
      some: { status: "ACCEPTED" as const, consultantProfile: { userId } },
    },
  };
  return {
    OR: [
      { consultationPlan: owns },
      { subscriptionPlan: owns },
      { webinarPlan: { OR: [owns, cohost] } },
      { classPlan: { OR: [owns, cohost] } },
    ],
  };
}

/** Learner or host access in one filter. */
export function materialReaderWhere(
  userId: string,
): Prisma.PlanMaterialWhereInput {
  return { OR: [hostMaterialWhere(userId), learnerMaterialWhere(userId)] };
}
