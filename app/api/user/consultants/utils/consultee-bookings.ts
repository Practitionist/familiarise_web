import prisma, { type Tx } from "@/lib/prisma";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { LIVE_PARTICIPANT_STATUSES } from "@/lib/booking/participants";
import {
  CANCELLABLE_FROM,
  RESCHEDULE_OPEN_STATUSES,
  TRIAL_ALLOWED_FROM,
} from "@/lib/booking/transitions";

/** The buyer-side twin of `ActiveAppointmentsResult`. */
export interface ConsulteeActiveBookingsResult {
  hasActive: boolean;
  total: number;
  breakdown: {
    liveConsultations: number;
    liveSubscriptions: number;
    liveTrials: number;
    openReschedules: number;
    upcomingSeats: number;
  };
  /** Human-readable details string (e.g., "1 live consultation, 2 upcoming seats") */
  details?: string;
}

type ConsulteeBookingsDb = Pick<
  Tx,
  | "consultation"
  | "subscription"
  | "trial"
  | "rescheduleRequest"
  | "appointmentParticipant"
>;

/**
 * The buyer's bookings that can still end, counted as `checkActiveAppointments`
 * counts the expert's: requests, plans, trials, open reschedules, group seats ahead.
 */
export async function checkConsulteeActiveBookings(
  consulteeProfileId: string,
  userId: string,
  db: ConsulteeBookingsDb = prisma,
): Promise<ConsulteeActiveBookingsResult> {
  const now = new Date();
  const [
    liveConsultations,
    liveSubscriptions,
    liveTrials,
    openReschedules,
    upcomingSeats,
  ] = await Promise.all([
    db.consultation.count({
      where: {
        requestedById: consulteeProfileId,
        status: { in: CANCELLABLE_FROM },
      },
    }),
    db.subscription.count({
      where: {
        requestedById: consulteeProfileId,
        status: { in: CANCELLABLE_FROM },
      },
    }),
    db.trial.count({
      where: {
        consulteeProfileId,
        status: { in: TRIAL_ALLOWED_FROM.CANCELLED },
      },
    }),
    db.rescheduleRequest.count({
      where: {
        status: { in: RESCHEDULE_OPEN_STATUSES },
        appointment: {
          deletedAt: null,
          participants: { some: { userId, role: "CONSULTEE" } },
        },
      },
    }),
    db.appointmentParticipant.count({
      where: {
        userId,
        role: "CONSULTEE",
        status: { in: LIVE_PARTICIPANT_STATUSES },
        appointment: {
          deletedAt: null,
          // A 1:1's own seat is already counted with its request above.
          appointmentType: { in: ["WEBINAR", "CLASS"] },
          occurrences: {
            some: { ...liveOccurrenceWhere, startsAt: { gt: now } },
          },
        },
      },
    }),
  ]);

  const total =
    liveConsultations +
    liveSubscriptions +
    liveTrials +
    openReschedules +
    upcomingSeats;

  const plural = (n: number, one: string) =>
    `${n} ${n === 1 ? one : `${one}s`}`;
  const detailParts = [
    [liveConsultations, "live consultation"],
    [liveSubscriptions, "live subscription"],
    [liveTrials, "live trial"],
    [openReschedules, "open reschedule request"],
    [upcomingSeats, "upcoming seat"],
  ] as const;
  const details = detailParts
    .filter(([n]) => n > 0)
    .map(([n, label]) => plural(n, label))
    .join(", ");

  return {
    hasActive: total > 0,
    total,
    breakdown: {
      liveConsultations,
      liveSubscriptions,
      liveTrials,
      openReschedules,
      upcomingSeats,
    },
    details: details || undefined,
  };
}
