import prisma, { type Tx } from "@/lib/prisma";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";

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
    activeTrials: number;
    openReschedules: number;
    activeCollaborations: number;
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
  | "collaborator"
>;

/**
 * Check if a consultant has any active/pending appointments or active upcoming collaborations.
 */
export async function checkActiveAppointments(
  consultantId: string,
  db: ActiveAppointmentsDb = prisma,
): Promise<ActiveAppointmentsResult> {
  const now = new Date();
  const activeStatuses = [
    "PENDING",
    "APPROVED",
    "APPROVED_PENDING_PAYMENT",
    "SCHEDULED",
  ] as const;

  const futureLiveOccurrence = {
    deletedAt: null,
    completionStatus: {
      notIn: ["CANCELLED" as const, "RESCHEDULED" as const, "VOIDED" as const],
    },
    startsAt: { gt: now },
  };

  const [
    pendingConsultations,
    activeSubscriptions,
    upcomingWebinars,
    upcomingClasses,
    activeTrials,
    openReschedules,
    activeCollaborations,
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
            some: { startsAt: { gte: now } },
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
        status: { in: RESCHEDULE_OPEN_STATUSES },
        appointment: {
          deletedAt: null,
          occurrences: { some: { consultantProfileId: consultantId } },
        },
      },
    }),
    db.collaborator?.count
      ? db.collaborator.count({
          where: {
            consultantProfileId: consultantId,
            status: "ACCEPTED",
            OR: [
              {
                webinarPlan: {
                  webinars: {
                    some: {
                      deletedAt: null,
                      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
                      appointment: {
                        deletedAt: null,
                        occurrences: { some: futureLiveOccurrence },
                      },
                    },
                  },
                },
              },
              {
                classPlan: {
                  classes: {
                    some: {
                      deletedAt: null,
                      status: { in: ["SCHEDULED", "IN_PROGRESS"] },
                      appointment: {
                        deletedAt: null,
                        occurrences: { some: futureLiveOccurrence },
                      },
                    },
                  },
                },
              },
            ],
          },
        })
      : Promise.resolve(0),
  ]);

  const total =
    pendingConsultations +
    activeSubscriptions +
    upcomingWebinars +
    upcomingClasses +
    activeTrials +
    openReschedules +
    activeCollaborations;

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
  if (activeCollaborations > 0) {
    detailParts.push(plural(activeCollaborations, "upcoming collaboration"));
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
      activeCollaborations,
    },
    details: detailParts.length > 0 ? detailParts.join(", ") : undefined,
  };
}
