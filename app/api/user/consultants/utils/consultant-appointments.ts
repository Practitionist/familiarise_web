import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";

/**
 * Which bookings count. `scheduleSwitch`: only those that still need the
 * expert's hours (a session ahead, or nothing placed yet on a paid or approved
 * booking or a class). `removal`: every open booking, for profile and account deletion.
 */
export type ActiveAppointmentsRule = "scheduleSwitch" | "removal";

export interface ActiveAppointmentsResult {
  hasActive: boolean;
  total: number;
  breakdown: {
    consultations: number;
    subscriptions: number;
    webinars: number;
    classes: number;
    trials: number;
    openReschedules: number;
    collaborations: number;
  };
  /** The counts in words, comma-joined ("2 upcoming webinars, 1 active trial"). */
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

const LIVE_OCCURRENCE = {
  deletedAt: null,
  completionStatus: {
    notIn: ["CANCELLED" as const, "RESCHEDULED" as const, "VOIDED" as const],
  },
};

/** A booking wrapper with a live session starting after `now`. */
const sessionAhead = (now: Date) => ({
  appointment: {
    deletedAt: null,
    occurrences: { some: { ...LIVE_OCCURRENCE, startsAt: { gt: now } } },
  },
});

/** No live session placed: no booking wrapper yet, or none of its sessions is live. */
const NOTHING_PLACED = {
  OR: [
    { appointment: { is: null } },
    { appointment: { occurrences: { none: LIVE_OCCURRENCE } } },
  ],
};

/** A request still waiting to be placed blocks only once it is approved or paid. */
const AWAITING_PLACEMENT = {
  OR: [
    {
      status: {
        in: ["APPROVED" as const, "APPROVED_PENDING_PAYMENT" as const],
      },
    },
    {
      appointment: {
        payment: { some: { paymentStatus: "SUCCEEDED" as const } },
      },
    },
  ],
};

/**
 * Count a consultant's bookings and co-hosted sessions under `rule`. The
 * switch pre-flight and the settings save's in-transaction re-check both call
 * it with `scheduleSwitch`, so they agree.
 */
export async function checkActiveAppointments(
  consultantId: string,
  db: ActiveAppointmentsDb,
  rule: ActiveAppointmentsRule,
): Promise<ActiveAppointmentsResult> {
  const now = new Date();
  const activeStatuses = [
    "PENDING",
    "APPROVED",
    "APPROVED_PENDING_PAYMENT",
  ] as const;
  const needsHours = rule === "scheduleSwitch";

  const futureLiveOccurrence = { ...LIVE_OCCURRENCE, startsAt: { gt: now } };
  const oneToOneNeedsHours = {
    OR: [sessionAhead(now), { AND: [NOTHING_PLACED, AWAITING_PLACEMENT] }],
  };
  const classNeedsHours = { OR: [sessionAhead(now), NOTHING_PLACED] };

  const [
    consultations,
    subscriptions,
    webinars,
    classes,
    trials,
    openReschedules,
    collaborations,
  ] = await Promise.all([
    db.consultation.count({
      where: {
        consultationPlan: { consultantProfileId: consultantId },
        status: { in: [...activeStatuses] },
        ...(needsHours ? oneToOneNeedsHours : {}),
      } satisfies Prisma.ConsultationWhereInput,
    }),
    db.subscription.count({
      where: {
        subscriptionPlan: { consultantProfileId: consultantId },
        status: { in: [...activeStatuses] },
        ...(needsHours ? oneToOneNeedsHours : {}),
      } satisfies Prisma.SubscriptionWhereInput,
    }),
    db.webinar.count({
      where: {
        webinarPlan: { consultantProfileId: consultantId },
        status: "SCHEDULED",
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
        status: "SCHEDULED",
        ...(needsHours ? classNeedsHours : {}),
      } satisfies Prisma.ClassWhereInput,
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
                      status: "SCHEDULED",
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
                      status: "SCHEDULED",
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
    consultations +
    subscriptions +
    webinars +
    classes +
    trials +
    openReschedules +
    collaborations;

  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  type Words = readonly [one: string, many: string];
  const words: Record<"consultations" | "subscriptions" | "classes", Words> =
    needsHours
      ? {
          consultations: [
            "consultation with a session ahead or still to be placed",
            "consultations with a session ahead or still to be placed",
          ],
          subscriptions: [
            "subscription with a session ahead or still to be placed",
            "subscriptions with a session ahead or still to be placed",
          ],
          classes: [
            "class with a session ahead or still to be scheduled",
            "classes with a session ahead or still to be scheduled",
          ],
        }
      : {
          consultations: ["pending consultation", "pending consultations"],
          subscriptions: ["active subscription", "active subscriptions"],
          classes: ["upcoming class", "upcoming classes"],
        };
  const counted: [number, Words][] = [
    [consultations, words.consultations],
    [subscriptions, words.subscriptions],
    [webinars, ["upcoming webinar", "upcoming webinars"]],
    [classes, words.classes],
    [trials, ["active trial", "active trials"]],
    [openReschedules, ["open reschedule request", "open reschedule requests"]],
    [collaborations, ["upcoming collaboration", "upcoming collaborations"]],
  ];
  const detailParts = counted
    .filter(([n]) => n > 0)
    .map(([n, [one, many]]) => plural(n, one, many));

  return {
    hasActive: total > 0,
    total,
    breakdown: {
      consultations,
      subscriptions,
      webinars,
      classes,
      trials,
      openReschedules,
      collaborations,
    },
    details: detailParts.length > 0 ? detailParts.join(", ") : undefined,
  };
}
