import type { AppointmentStatus, Prisma, TrialStatus } from "@prisma/client";

/**
 * Who may open a plan material: the plan's owner, its accepted co-hosts, org
 * operators who manage the plan's materials, and learners on a paid booking.
 * Every material list and the open routes use these arms, so a listed file can
 * always be opened and an unpaid booking never reaches one.
 */

/** Paid, accepted request states; anything else (requested, awaiting payment, closed) is not a buyer. */
export const PAID_REQUEST_STATUSES: AppointmentStatus[] = [
  "APPROVED",
  "COMPLETED",
];

const LIVE_SEAT_STATUSES = ["CONFIRMED", "ATTENDED"] as const;

/** Trial states that follow a confirmed booking; PENDING and AWAITING_PAYMENT are not buyers yet. */
const TRIAL_ACCESS_STATUSES: TrialStatus[] = [
  "SCHEDULED",
  "COMPLETED",
  "CONVERTED",
];

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
  // A trial is the plan's front door: once its call is confirmed or held, the
  // consultee reads the same materials a subscriber does.
  const heldTrial = {
    consulteeProfile: { userId },
    status: { in: TRIAL_ACCESS_STATUSES },
    appointment: { is: { deletedAt: null } },
  };
  return {
    OR: [
      { consultationPlan: { consultations: { some: paidRequest } } },
      { subscriptionPlan: { subscriptions: { some: paidRequest } } },
      { subscriptionPlan: { trials: { some: heldTrial } } },
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
