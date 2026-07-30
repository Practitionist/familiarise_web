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

/**
 * @param userId              the signed-in user
 * @param consultantProfileId their delivering profile
 */
export async function getNeedsYouSummary(
  userId: string,
  consultantProfileId: string,
): Promise<NeedsYouSummary> {
  // Orgs this person DELIVERS into. A LEARNER membership is not a delivery
  // context and must not appear here — nothing is ever awaiting their
  // allocation there.
  const deliveringMemberships = await prisma.membership.findMany({
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
  });

  const scopes: { organizationId: string | null; label: string; href: string }[] =
    [
      {
        organizationId: null,
        label: "Personal",
        href: `/dashboard/consultant/${consultantProfileId}/requests`,
      },
      ...deliveringMemberships.map((m) => ({
        organizationId: m.organizationId,
        label: m.organization.name,
        href: `/dashboard/organization/${m.organizationId}/requests`,
      })),
    ];

  const contexts = await Promise.all(
    scopes.map(async (scope) => {
      // Scope predicates are copied verbatim from the two endpoints that back
      // the Requests page (app/api/bookings/{consultations,subscriptions}),
      // including their asymmetry: Consultation has one optional Appointment
      // and counts a missing one as personal ("not org-funded → personal"),
      // whereas Subscription has many and uses none/some. If the panel and the
      // page disagreed on what personal means, the count would send people to
      // a list that doesn't contain the item.
      const isPersonal = scope.organizationId === null;

      const [consultations, subscriptions] = await Promise.all([
        prisma.consultation.count({
          where: {
            status: "PENDING",
            consultationPlan: { consultantProfileId },
            ...(isPersonal
              ? {
                  OR: [
                    { appointment: null },
                    { appointment: { organizationId: null } },
                  ],
                }
              : { appointment: { organizationId: scope.organizationId } }),
          },
        }),
        prisma.subscription.count({
          where: {
            status: "PENDING",
            subscriptionPlan: { consultantProfileId },
            appointments: isPersonal
              ? { none: { organizationId: { not: null } } }
              : { some: { organizationId: scope.organizationId } },
          },
        }),
      ]);

      return {
        ...scope,
        pendingRequests: consultations + subscriptions,
      };
    }),
  );

  const withWork = contexts.filter((c) => c.pendingRequests > 0);

  return {
    contexts: withWork,
    total: withWork.reduce((sum, c) => sum + c.pendingRequests, 0),
  };
}
