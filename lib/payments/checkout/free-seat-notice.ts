// The booked notice for a free event seat, which no capture confirms.

import prisma, { type Tx } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import {
  loadAppointmentForEmails,
  stageBookedBells,
  stageBookedEmails,
} from "@/lib/payments/webhooks/staged-emails";

/** The join a checkout committed: the seat and the SEAT history row its registration or rejoin wrote. */
export interface SeatJoin {
  participantId: string;
  joinId: string;
}

/** The join the buyer's free checkout just wrote on this event: its latest registration or rejoin SEAT row. */
export async function readSeatJoin(
  tx: Pick<Tx, "bookingStatusHistory">,
  appointmentId: string,
  userId: string,
): Promise<SeatJoin | null> {
  const row = await tx.bookingStatusHistory.findFirst({
    where: {
      entity: "SEAT",
      appointmentId,
      actorUserId: userId,
      reason: { in: ["registered", "rejoined"] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, entityId: true },
  });
  return row ? { participantId: row.entityId, joinId: row.id } : null;
}

/** Keyed per seat and join, so a rejoin gets its own notice and a re-stage of one join does not. */
export const freeSeatRegisteredKey = (participantId: string, joinId: string) =>
  `seat-registered:${participantId}:${joinId}`;

const FREE_SEAT_NOTICE_SCOPE = "seat-registered";
const FREE_SEAT_NOTICE_CLAIM_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stages the "you're registered" bell and emails after a zero-amount event seat
 * commits. The seat is already sold, so a failure here is reported, never thrown.
 */
export async function notifyFreeSeatRegistered(args: {
  appointmentId: string;
  userId: string;
  appointmentType: "WEBINAR" | "CLASS";
  join: SeatJoin;
}): Promise<void> {
  try {
    await stageFreeSeatNotice(args);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "payments",
      op: "checkout.free-seat-booked",
      expected: false,
    });
  }
}

async function stageFreeSeatNotice(args: {
  appointmentId: string;
  userId: string;
  appointmentType: "WEBINAR" | "CLASS";
  join: SeatJoin;
}): Promise<void> {
  const key = freeSeatRegisteredKey(args.join.participantId, args.join.joinId);
  await stageNowAttemptAfter("checkout.free-seat-booked", () =>
    prisma.$transaction(async (tx) => {
      // One claim per join covers both channels; it commits with what it staged.
      const now = new Date();
      const claimed = await tx.idempotencyRecord.createMany({
        data: [
          {
            scope: FREE_SEAT_NOTICE_SCOPE,
            key,
            userId: args.userId,
            requestHash: key,
            completedAt: now,
            expiresAt: new Date(now.getTime() + FREE_SEAT_NOTICE_CLAIM_MS),
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count === 0) return {};
      const learner = await tx.user.findUnique({
        where: { id: args.userId },
        select: { name: true },
      });
      const appointment = await loadAppointmentForEmails(
        tx,
        args.appointmentId,
      );
      if (!learner || !appointment) return {};
      const booker = { userId: args.userId, user: { name: learner.name } };
      const emails = await stageBookedEmails(
        tx,
        booker,
        appointment,
        args.appointmentType,
      );
      const bells = await stageBookedBells(
        tx,
        booker,
        appointment,
        args.appointmentType,
        key,
      );
      return {
        bells,
        emails: [{ rows: emails, emailType: "APPOINTMENT_BOOKED" }],
      };
    }),
  );
}
