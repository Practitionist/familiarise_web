import type { Tx } from "@/lib/prisma";

/**
 * Who must answer a claim.
 *
 * The respondent is the counterparty who delivered (or was to deliver) the
 * session:
 *   - a HOST ORGANISATION answers when the platform's marketplace expert is
 *     actually the organisation's own EXPERT member (`Payment.hostOrganizationId`);
 *   - otherwise the delivering CONSULTANT answers.
 *
 * The organisation answers through its OWNER / MAINTAINER members, which is
 * the same boundary every other org surface uses: an organisation speaks for
 * itself through its governance, and its LEARNER and EXPERT members are not
 * its spokesperson.
 */

export type ResolvedRespondent =
  | { type: "CONSULTANT"; userId: string; name: string }
  | { type: "ORGANIZATION"; organizationId: string; name: string };

/**
 * The consultants who delivered the booking, newest first by participation.
 * The first one is the respondent; the rest are the co-delivery parties, who
 * the platform may ask for evidence.
 */
export async function deliveringConsultantIds(
  tx: Tx,
  appointmentId: string | null,
): Promise<string[]> {
  if (!appointmentId) return [];
  const plan = { consultantProfileId: true } as const;
  const groupPlan = {
    ...plan,
    collaborators: {
      where: { status: "ACCEPTED" as const },
      select: { consultantProfileId: true },
    },
  };
  const booking = await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      participants: {
        where: {
          role: { in: ["CONSULTANT", "COLLABORATOR"] },
          status: { in: ["CONFIRMED", "ATTENDED"] },
        },
        select: { userId: true },
      },
      consultation: { select: { consultationPlan: { select: plan } } },
      subscription: { select: { subscriptionPlan: { select: plan } } },
      webinar: { select: { webinarPlan: { select: groupPlan } } },
      class: { select: { classPlan: { select: groupPlan } } },
    },
  });
  if (!booking) return [];

  const people = new Set(booking.participants.map((p) => p.userId));
  const profileIds = [
    booking.consultation?.consultationPlan.consultantProfileId,
    booking.subscription?.subscriptionPlan.consultantProfileId,
    booking.webinar?.webinarPlan.consultantProfileId,
    booking.class?.classPlan.consultantProfileId,
    ...(booking.webinar?.webinarPlan.collaborators ?? []).map(
      (c) => c.consultantProfileId,
    ),
    ...(booking.class?.classPlan.collaborators ?? []).map(
      (c) => c.consultantProfileId,
    ),
  ].filter((profileId): profileId is string => Boolean(profileId));

  const profiles = await tx.consultantProfile.findMany({
    where: { id: { in: profileIds }, deletedAt: null },
    select: { user: { select: { id: true } } },
  });
  profiles.forEach((profile) => {
    if (profile.user) people.add(profile.user.id);
  });
  return [...people];
}

/**
 * Resolve the respondent for a claim.
 *
 * A host organisation wins over an individual consultant: when the platform's
 * marketplace listing was actually delivered by the organisation's own member,
 * the organisation is the counterparty and it — not the member — answers.
 */
export async function resolveRespondent(
  tx: Tx,
  args: {
    appointmentId: string | null;
    hostOrganizationId: string | null;
  },
): Promise<ResolvedRespondent | null> {
  if (args.hostOrganizationId) {
    const organization = await tx.organization.findUnique({
      where: { id: args.hostOrganizationId },
      select: { id: true, name: true },
    });
    if (organization) {
      return {
        type: "ORGANIZATION",
        organizationId: organization.id,
        name: organization.name,
      };
    }
  }

  const consultantIds = await deliveringConsultantIds(tx, args.appointmentId);
  const first = consultantIds[0];
  if (!first) return null;
  const consultant = await tx.user.findUnique({
    where: { id: first },
    select: { id: true, name: true, banned: true },
  });
  if (!consultant || consultant.banned) return null;
  return {
    type: "CONSULTANT",
    userId: consultant.id,
    name: consultant.name,
  };
}

/**
 * The organisation members who may answer on the organisation's behalf.
 * Governance only: an organisation speaks through its OWNER and MAINTAINER.
 */
export async function organizationRespondentIds(
  tx: Tx,
  organizationId: string,
): Promise<string[]> {
  const members = await tx.membership.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      role: { in: ["OWNER", "MAINTAINER"] },
    },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}
