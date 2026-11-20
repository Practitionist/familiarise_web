import { AppointmentStatus, BookingSource, type Prisma } from "@prisma/client";
import {
  BEING_MOVED,
  countOpenRequestsForCap,
  holdingSince,
  type RequestCounters,
} from "@/lib/data/needs-you";

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
 * How many consultation requests this consultee has waiting for an answer:
 * PENDING, actually submitted as a request (a checkout hold is not one) and
 * still inside its hold window.
 *
 * Structurally typed rather than Pick<PrismaClient, …>: the extended client
 * (lib/prisma) is a DynamicClientExtensionThis whose comparison against
 * PrismaClient blows tsc's stack; every caller passes that client.
 */
export async function countActiveConsultationRequests(
  db: {
    consultation: {
      count: (args: {
        where: Prisma.ConsultationWhereInput;
      }) => Promise<number>;
    };
  },
  consulteeProfileId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.consultation.count({
    where: {
      requestedById: consulteeProfileId,
      status: AppointmentStatus.PENDING,
      bookingSource: BookingSource.REQUEST_SUBMITTED,
      // A request past its hold window holds nothing, swept or not: occupancy
      // frees its time at the same instant (`buildDeadHoldFilter`).
      requestedAt: { gte: holdingSince("CONSULTATION", now) },
      NOT: { appointment: BEING_MOVED },
    },
  });
}

/** The consultee's own cap, as a typed refusal with plain copy. */
export const REQUEST_CAP_REACHED = {
  code: "REQUEST_CAP_REACHED",
  message: `You already have ${MAX_ACTIVE_REQUESTS_PER_USER} requests waiting for an answer. Wait for an expert to reply, or withdraw one from your dashboard, then try again.`,
} as const;

/**
 * #1703 D4 — the consultant-side gate: a pause toggle and an optional cap on
 * open submitted requests (see `countOpenRequestsForCap`).
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

/** The pause refusal, decided before any lock is taken. */
export function pausedRefusal(profile: {
  acceptingRequests: boolean;
}): ConsultantRequestRefusal | null {
  return profile.acceptingRequests ? null : CONSULTANT_PAUSED;
}

/**
 * The cap refusal. Call it inside the `request-cap` lock with the write
 * transaction: the count (submitted 1:1 and plan requests still inside their
 * hold; a trial never counts) is the guard, and a cap of null skips the read.
 */
export async function capacityRefusal(
  db: RequestCounters,
  profile: { id: string; maxOpenRequests: number | null },
  now: Date = new Date(),
): Promise<ConsultantRequestRefusal | null> {
  if (profile.maxOpenRequests === null) return null;
  const open = await countOpenRequestsForCap(profile.id, db, now);
  return open >= profile.maxOpenRequests ? CONSULTANT_AT_CAPACITY : null;
}
