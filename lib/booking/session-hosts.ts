/**
 * Who counts as "the host side" of a session: the plan's consultant plus every
 * collaborator on a webinar or class, whatever their tier. A crew member
 * keeping the room alive still delivers the session.
 */

import type { Prisma } from "@prisma/client";

const OWNER = {
  consultantProfile: { select: { userId: true } },
} satisfies Prisma.ConsultationPlanSelect;

// Every period a collaborator ever held on the team. The trigger
// collaborator_transition_guard stamps acceptedAt and endedAt, and the CHECK
// collaborator_period_is_coherent ties them to the status.
const COLLABORATOR_PERIODS = {
  where: { acceptedAt: { not: null } },
  select: {
    status: true,
    acceptedAt: true,
    endedAt: true,
    consultantProfile: { select: { userId: true, deletedAt: true } },
  },
} satisfies Prisma.WebinarPlan$collaboratorsArgs;

/** Select on `Appointment`; feed the row to {@link sessionHostUserIds}. */
export const SESSION_HOSTS_SELECT = {
  consultation: { select: { consultationPlan: { select: OWNER } } },
  subscription: { select: { subscriptionPlan: { select: OWNER } } },
  trial: { select: { subscriptionPlan: { select: OWNER } } },
  webinar: {
    select: {
      webinarPlan: {
        select: { ...OWNER, collaborators: COLLABORATOR_PERIODS },
      },
    },
  },
  class: {
    select: {
      classPlan: {
        select: { ...OWNER, collaborators: COLLABORATOR_PERIODS },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

export type SessionHostsRow = Prisma.AppointmentGetPayload<{
  select: typeof SESSION_HOSTS_SELECT;
}>;

type CollaboratorPeriod = NonNullable<
  SessionHostsRow["class"]
>["classPlan"]["collaborators"][number];

function hostSide(
  row: SessionHostsRow,
  counts: (period: CollaboratorPeriod) => boolean,
): string[] {
  const plan = row.webinar?.webinarPlan ?? row.class?.classPlan ?? null;
  return [
    ...new Set(
      [
        row.consultation?.consultationPlan.consultantProfile.userId,
        row.subscription?.subscriptionPlan.consultantProfile.userId,
        row.trial?.subscriptionPlan.consultantProfile.userId,
        plan?.consultantProfile?.userId,
        ...(plan?.collaborators ?? [])
          .filter(counts)
          .map((c) => c.consultantProfile.userId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

/**
 * The host side a session had: the owner plus every collaborator whose accepted
 * period overlaps the booked window at all. A removal or an erased profile after
 * the session does not change who delivered it.
 */
export function sessionHostUserIds(
  row: SessionHostsRow,
  booked: { startsAt: Date; endsAt: Date },
): string[] {
  return hostSide(
    row,
    (c) =>
      c.acceptedAt !== null &&
      c.acceptedAt < booked.endsAt &&
      (c.endedAt === null || c.endedAt > booked.startsAt),
  );
}

/** Today's roster, for a permission check: the owner plus each collaborator accepted now whose profile is live. */
export function currentSessionHostUserIds(row: SessionHostsRow): string[] {
  return hostSide(
    row,
    (c) => c.status === "ACCEPTED" && c.consultantProfile.deletedAt === null,
  );
}
