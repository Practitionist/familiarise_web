import { AppointmentStatus } from "@prisma/client";

/**
 * Anti-scalper cap for request-for-approval holds (booking-journey audit B1).
 *
 * Every PENDING consultation request pins a tentative slot that blocks the
 * consultant's calendar, and nothing used to bound how many one account
 * could accumulate — the hourly rate limiter still allowed a bot farm to pin
 * a popular consultant's entire inventory for days. The cap is on ACTIVE
 * (PENDING) requests only: approved-awaiting-payment requests are bounded by
 * Payment.expiresAt sweeps instead, and terminal requests hold nothing.
 */

export const MAX_ACTIVE_REQUESTS_PER_USER = 3;

/**
 * How many PENDING consultation requests this consultee currently has open.
 *
 * Structurally typed rather than Pick<PrismaClient, …>: the extended client
 * (lib/prisma) is a DynamicClientExtensionThis whose comparison against
 * PrismaClient blows tsc's stack; every caller passes that client.
 */
export async function countActiveConsultationRequests(
  db: {
    consultation: {
      count: (args: {
        where: {
          requestedById: string;
          status: AppointmentStatus;
        };
      }) => Promise<number>;
    };
  },
  consulteeProfileId: string,
): Promise<number> {
  return db.consultation.count({
    where: {
      requestedById: consulteeProfileId,
      status: AppointmentStatus.PENDING,
    },
  });
}

/**
 * #1703 D4 — the consultant-side gate: a pause toggle and an optional cap on
 * open PENDING requests (consultations and subscriptions, live rows only).
 * Null cap means off. The route answers a typed 409 for either refusal.
 */
export type ConsultantRequestRefusal = {
  code: "CONSULTANT_PAUSED" | "CONSULTANT_AT_CAPACITY";
  message: string;
};

export const CONSULTANT_PAUSED: ConsultantRequestRefusal = {
  code: "CONSULTANT_PAUSED",
  message:
    "This expert is not taking new requests right now. Pick another expert, or try again later.",
};

export const CONSULTANT_AT_CAPACITY: ConsultantRequestRefusal = {
  code: "CONSULTANT_AT_CAPACITY",
  message:
    "This expert's request queue is full — try again in a day or two, or pick another expert.",
};

type OpenRequestCounter = {
  count: (args: {
    where: {
      status: AppointmentStatus;
      deletedAt: null;
      consultationPlan?: { consultantProfileId: string };
      subscriptionPlan?: { consultantProfileId: string };
    };
  }) => Promise<number>;
};

/** Open PENDING requests against this consultant, both request kinds. */
export async function countOpenRequestsForConsultant(
  db: { consultation: OpenRequestCounter; subscription: OpenRequestCounter },
  consultantProfileId: string,
): Promise<number> {
  const [consultations, subscriptions] = await Promise.all([
    db.consultation.count({
      where: {
        status: AppointmentStatus.PENDING,
        deletedAt: null,
        consultationPlan: { consultantProfileId },
      },
    }),
    db.subscription.count({
      where: {
        status: AppointmentStatus.PENDING,
        deletedAt: null,
        subscriptionPlan: { consultantProfileId },
      },
    }),
  ]);
  return consultations + subscriptions;
}

/** The pause refusal, decided before any lock is taken. */
export function pausedRefusal(profile: {
  acceptingRequests: boolean;
}): ConsultantRequestRefusal | null {
  return profile.acceptingRequests ? null : CONSULTANT_PAUSED;
}

/**
 * The cap refusal. Call it inside the consultant-keyed lock: the count is the
 * guard, and a cap of null skips the read entirely.
 */
export async function capacityRefusal(
  db: { consultation: OpenRequestCounter; subscription: OpenRequestCounter },
  profile: { id: string; maxOpenRequests: number | null },
): Promise<ConsultantRequestRefusal | null> {
  if (profile.maxOpenRequests === null) return null;
  const open = await countOpenRequestsForConsultant(db, profile.id);
  return open >= profile.maxOpenRequests ? CONSULTANT_AT_CAPACITY : null;
}
