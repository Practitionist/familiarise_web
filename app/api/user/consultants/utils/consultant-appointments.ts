import prisma from "@/lib/prisma";

/**
 * Result of checking active appointments for a consultant
 */
export interface ActiveAppointmentsResult {
  hasActive: boolean;
  total: number;
  breakdown: {
    pendingConsultations: number;
    activeSubscriptions: number;
    upcomingWebinars: number;
    upcomingCohorts: number;
  };
  /** Human-readable details string (e.g., "2 pending consultations, 1 active subscription") */
  details?: string;
}

/**
 * Check if a consultant has any active/pending appointments.
 * Used to validate before allowing schedule type changes.
 *
 * Active appointments include:
 * - Consultations with status: PENDING, APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED
 * - Subscriptions with status: PENDING, APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED
 * - Webinars with status: SCHEDULED, IN_PROGRESS (with future slots)
 * - Classes with status: SCHEDULED, IN_PROGRESS
 */
export async function checkActiveAppointments(
  consultantId: string,
): Promise<ActiveAppointmentsResult> {
  const activeStatuses = [
    "PENDING",
    "APPROVED",
    "APPROVED_PENDING_PAYMENT",
    "SCHEDULED",
  ] as const;

  const [
    pendingConsultations,
    activeSubscriptions,
    upcomingWebinars,
    upcomingCohorts,
  ] = await Promise.all([
    prisma.consultation.count({
      where: {
        consultationPlan: { consultantProfileId: consultantId },
        status: { in: [...activeStatuses] },
      },
    }),
    prisma.subscription.count({
      where: {
        subscriptionPlan: { consultantProfileId: consultantId },
        status: { in: [...activeStatuses] },
      },
    }),
    prisma.webinar.count({
      where: {
        webinarPlan: { consultantProfileId: consultantId },
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        appointment: {
          occurrences: {
            some: { startsAt: { gte: new Date() } },
          },
        },
      },
    }),
    prisma.cohort.count({
      where: {
        cohortPlan: { consultantProfileId: consultantId },
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      },
    }),
  ]);

  const total =
    pendingConsultations +
    activeSubscriptions +
    upcomingWebinars +
    upcomingCohorts;

  // Build human-readable details
  const detailParts: string[] = [];
  if (pendingConsultations > 0) {
    detailParts.push(
      `${pendingConsultations} pending consultation${pendingConsultations > 1 ? "s" : ""}`,
    );
  }
  if (activeSubscriptions > 0) {
    detailParts.push(
      `${activeSubscriptions} active subscription${activeSubscriptions > 1 ? "s" : ""}`,
    );
  }
  if (upcomingWebinars > 0) {
    detailParts.push(
      `${upcomingWebinars} upcoming webinar${upcomingWebinars > 1 ? "s" : ""}`,
    );
  }
  if (upcomingCohorts > 0) {
    detailParts.push(
      `${upcomingCohorts} upcoming class${upcomingCohorts > 1 ? "es" : ""}`,
    );
  }

  return {
    hasActive: total > 0,
    total,
    breakdown: {
      pendingConsultations,
      activeSubscriptions,
      upcomingWebinars,
      upcomingCohorts,
    },
    details: detailParts.length > 0 ? detailParts.join(", ") : undefined,
  };
}
