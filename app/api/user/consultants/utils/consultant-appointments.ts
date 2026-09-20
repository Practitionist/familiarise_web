import prisma, { type Tx } from "@/lib/prisma";

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
    upcomingClasses: number;
    /** SCHEDULED / AWAITING_PAYMENT trials occupy a slot like a live booking. */
    activeTrials: number;
    /** Open reschedule requests still point at the published windows. */
    openReschedules: number;
  };
  /** Human-readable details string (e.g., "2 pending consultations, 1 active subscription") */
  details?: string;
}

type ActiveAppointmentsDb = Pick<
  Tx,
  | "consultation"
  | "subscription"
  | "webinar"
  | "class"
  | "trial"
  | "rescheduleRequest"
>;

/**
 * Check if a consultant has any active/pending appointments.
 * Used to validate before allowing schedule type changes.
 *
 * Active appointments include:
 * - Consultations with status: PENDING, APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED
 * - Subscriptions with status: PENDING, APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED
 * - Webinars with status: SCHEDULED, IN_PROGRESS (with future slots)
 * - Classes with status: SCHEDULED, IN_PROGRESS
 * - Trials with status: SCHEDULED, AWAITING_PAYMENT (occupancyPolicy treats
 *   both as occupying a slot; they were missing here, so a consultant with an
 *   accepted trial could switch schedule type underneath it)
 * - Reschedule requests still open (PENDING_REVIEW, COUNTERED)
 *
 * Takes `db` so the settings PUT can re-run the check inside the transaction
 * that flips scheduleType; the standalone read is a pre-flight only.
 */
export async function checkActiveAppointments(
  consultantId: string,
  db: ActiveAppointmentsDb = prisma,
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
    upcomingClasses,
    activeTrials,
    openReschedules,
  ] = await Promise.all([
    db.consultation.count({
      where: {
        consultationPlan: { consultantProfileId: consultantId },
        status: { in: [...activeStatuses] },
      },
    }),
    db.subscription.count({
      where: {
        subscriptionPlan: { consultantProfileId: consultantId },
        status: { in: [...activeStatuses] },
      },
    }),
    db.webinar.count({
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
    db.class.count({
      where: {
        classPlan: { consultantProfileId: consultantId },
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
      },
    }),
    db.trial.count({
      where: {
        consultantProfileId: consultantId,
        status: { in: ["SCHEDULED", "AWAITING_PAYMENT"] },
      },
    }),
    db.rescheduleRequest.count({
      where: {
        status: { in: ["PENDING_REVIEW", "COUNTERED"] },
        appointment: {
          deletedAt: null,
          occurrences: { some: { consultantProfileId: consultantId } },
        },
      },
    }),
  ]);

  const total =
    pendingConsultations +
    activeSubscriptions +
    upcomingWebinars +
    upcomingClasses +
    activeTrials +
    openReschedules;

  // Build human-readable details
  const detailParts: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  if (pendingConsultations > 0) {
    detailParts.push(plural(pendingConsultations, "pending consultation"));
  }
  if (activeSubscriptions > 0) {
    detailParts.push(plural(activeSubscriptions, "active subscription"));
  }
  if (upcomingWebinars > 0) {
    detailParts.push(plural(upcomingWebinars, "upcoming webinar"));
  }
  if (upcomingClasses > 0) {
    detailParts.push(
      plural(upcomingClasses, "upcoming class", "upcoming classes"),
    );
  }
  if (activeTrials > 0) {
    detailParts.push(plural(activeTrials, "active trial"));
  }
  if (openReschedules > 0) {
    detailParts.push(plural(openReschedules, "open reschedule request"));
  }

  return {
    hasActive: total > 0,
    total,
    breakdown: {
      pendingConsultations,
      activeSubscriptions,
      upcomingWebinars,
      upcomingClasses,
      activeTrials,
      openReschedules,
    },
    details: detailParts.length > 0 ? detailParts.join(", ") : undefined,
  };
}
