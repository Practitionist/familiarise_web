import prisma from "@/lib/prisma";

/**
 * Cross-context "needs you" roll-up for a consultant.
 *
 * ADR 19 splits the dashboards by the org-ness of the underlying work, and
 * accepts as a known cost that "a consultant who works through an organization
 * now visits two dashboards". It also states the only sanctioned remedy: a
 * cross-context summary "would have to be built as a derived read rather than
 * by re-merging the views". This is that derived read.
 *
 * It deliberately returns COUNTS AND LINKS ONLY. It does not return rows, and
 * nothing renders from it in place — every item routes the user into the
 * dashboard that owns the work, which is what keeps each number authoritative
 * in exactly one place.
 */

export interface NeedsYouContext {
  /** Null for the personal B2C context. */
  organizationId: string | null;
  label: string;
  /** Booking requests waiting for this consultant to allocate slots. */
  pendingRequests: number;
  /** Where to send someone who clicks through. */
  href: string;
}

export interface NeedsYouSummary {
  contexts: NeedsYouContext[];
  total: number;
}

function pendingConsultationWhere(
  consultantProfileId: string,
  organizationId: string | null,
) {
  const isPersonal = organizationId === null;
  return {
    status: "PENDING" as const,
    consultationPlan: { consultantProfileId },
    ...(isPersonal
      ? {
          OR: [
            { appointment: null },
            { appointment: { organizationId: null } },
          ],
        }
      : { appointment: { organizationId } }),
  };
}

function pendingSubscriptionWhere(
  consultantProfileId: string,
  organizationId: string | null,
) {
  const isPersonal = organizationId === null;
  return {
    status: "PENDING" as const,
    subscriptionPlan: { consultantProfileId },
    appointments: isPersonal
      ? { none: { organizationId: { not: null } } }
      : { some: { organizationId } },
  };
}

/**
 * @param userId              the signed-in user
 * @param consultantProfileId their delivering profile
 */
export async function getNeedsYouSummary(
  userId: string,
  consultantProfileId: string,
): Promise<NeedsYouSummary> {
  // Memberships + personal-scope counts share no dependency — fetch together
  // so the personal context does not wait on the membership round-trip.
  const [deliveringMemberships, personalConsultations, personalSubscriptions] =
    await Promise.all([
      prisma.membership.findMany({
        where: {
          userId,
          status: "ACTIVE",
          consultantProfileId,
          organization: { canHost: true },
        },
        select: {
          organizationId: true,
          organization: { select: { name: true } },
        },
      }),
      prisma.consultation.count({
        where: pendingConsultationWhere(consultantProfileId, null),
      }),
      prisma.subscription.count({
        where: pendingSubscriptionWhere(consultantProfileId, null),
      }),
    ]);

  const orgScopes = deliveringMemberships.map((m) => ({
    organizationId: m.organizationId as string,
    label: m.organization.name,
    href: `/dashboard/organization/${m.organizationId}/requests`,
  }));

  const orgCounts = await Promise.all(
    orgScopes.map(async (scope) => {
      const [consultations, subscriptions] = await Promise.all([
        prisma.consultation.count({
          where: pendingConsultationWhere(
            consultantProfileId,
            scope.organizationId,
          ),
        }),
        prisma.subscription.count({
          where: pendingSubscriptionWhere(
            consultantProfileId,
            scope.organizationId,
          ),
        }),
      ]);
      return {
        ...scope,
        pendingRequests: consultations + subscriptions,
      };
    }),
  );

  const contexts = [
    {
      organizationId: null,
      label: "Personal",
      href: `/dashboard/consultant/${consultantProfileId}/requests`,
      pendingRequests: personalConsultations + personalSubscriptions,
    },
    ...orgCounts,
  ].filter((c) => c.pendingRequests > 0);

  return {
    contexts,
    total: contexts.reduce((sum, c) => sum + c.pendingRequests, 0),
  };
}
