/**
 * Who counts as "the host side" of a session: the plan's consultant plus the
 * collaborators on a webinar or class, whatever their tier. A crew member
 * keeping the room alive still delivers the session.
 */

import type { Prisma } from "@prisma/client";

const OWNER = {
  consultantProfile: { select: { userId: true } },
} satisfies Prisma.ConsultationPlanSelect;

// Every row with its period: a session is judged against the team it had.
const COLLABORATORS = {
  select: {
    status: true,
    acceptedAt: true,
    endedAt: true,
    consultantProfile: { select: { userId: true, deletedAt: true } },
  },
} satisfies Prisma.WebinarPlan$collaboratorsArgs;

/** Select on `Appointment`; feed the row to {@link sessionHostUserIds} or {@link sessionHostUserIdsAt}. */
export const SESSION_HOSTS_SELECT = {
  consultation: { select: { consultationPlan: { select: OWNER } } },
  subscription: { select: { subscriptionPlan: { select: OWNER } } },
  trial: { select: { subscriptionPlan: { select: OWNER } } },
  webinar: {
    select: {
      webinarPlan: {
        select: { ...OWNER, collaborators: COLLABORATORS },
      },
    },
  },
  class: {
    select: {
      classPlan: {
        select: { ...OWNER, collaborators: COLLABORATORS },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

export type SessionHostsRow = Prisma.AppointmentGetPayload<{
  select: typeof SESSION_HOSTS_SELECT;
}>;

type TeamRow = NonNullable<
  NonNullable<SessionHostsRow["class"]>["classPlan"]
>["collaborators"][number];

function hostSide(
  row: SessionHostsRow,
  onTeam: (member: TeamRow) => boolean,
): string[] {
  const plan = row.webinar?.webinarPlan ?? row.class?.classPlan ?? null;
  const team: readonly TeamRow[] = plan?.collaborators ?? [];
  return [
    ...new Set(
      [
        row.consultation?.consultationPlan.consultantProfile.userId,
        row.subscription?.subscriptionPlan.consultantProfile.userId,
        row.trial?.subscriptionPlan.consultantProfile.userId,
        plan?.consultantProfile?.userId,
        ...team.filter(onTeam).map((c) => c.consultantProfile.userId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

/** The host side today: the consultant and the ACCEPTED team. An erased profile is never on it. */
export function sessionHostUserIds(row: SessionHostsRow): string[] {
  return hostSide(
    row,
    (c) => c.status === "ACCEPTED" && c.consultantProfile.deletedAt === null,
  );
}

/**
 * The host side of the session from `startsAt` to `endsAt`: the consultant and
 * every collaborator whose accepted period overlaps it, so someone who taught
 * it and left the team afterwards is still its host.
 */
export function sessionHostUserIdsAt(
  row: SessionHostsRow,
  startsAt: Date,
  endsAt: Date,
): string[] {
  return hostSide(
    row,
    (c) =>
      c.acceptedAt !== null &&
      c.acceptedAt < endsAt &&
      (c.endedAt === null || c.endedAt > startsAt),
  );
}
