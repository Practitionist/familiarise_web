/**
 * #1569 D1 — who counts as "the host side" of a session: the plan's consultant
 * plus every ACCEPTED collaborator on a webinar or class, whatever their tier.
 * A crew member keeping the room alive still delivers the session.
 */

import type { Prisma } from "@prisma/client";

const OWNER = {
  consultantProfile: { select: { userId: true } },
} satisfies Prisma.ConsultationPlanSelect;

const ACCEPTED_COLLABORATORS = {
  where: { status: "ACCEPTED" },
  select: { consultantProfile: { select: { userId: true } } },
} satisfies Prisma.WebinarPlan$collaboratorsArgs;

/** Select on `Appointment`; feed the row to {@link sessionHostUserIds}. */
export const SESSION_HOSTS_SELECT = {
  consultation: { select: { consultationPlan: { select: OWNER } } },
  subscription: { select: { subscriptionPlan: { select: OWNER } } },
  trial: { select: { subscriptionPlan: { select: OWNER } } },
  webinar: {
    select: {
      webinarPlan: {
        select: { ...OWNER, collaborators: ACCEPTED_COLLABORATORS },
      },
    },
  },
  class: {
    select: {
      classPlan: {
        select: { ...OWNER, collaborators: ACCEPTED_COLLABORATORS },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

export type SessionHostsRow = Prisma.AppointmentGetPayload<{
  select: typeof SESSION_HOSTS_SELECT;
}>;

export function sessionHostUserIds(row: SessionHostsRow): string[] {
  const plan = row.webinar?.webinarPlan ?? row.class?.classPlan ?? null;
  return [
    ...new Set(
      [
        row.consultation?.consultationPlan.consultantProfile.userId,
        row.subscription?.subscriptionPlan.consultantProfile.userId,
        row.trial?.subscriptionPlan.consultantProfile.userId,
        plan?.consultantProfile?.userId,
        ...(plan?.collaborators ?? []).map((c) => c.consultantProfile.userId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}
