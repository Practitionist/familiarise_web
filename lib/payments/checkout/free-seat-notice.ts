// The booked notice for a free event seat, which no capture confirms.

import type { Tx } from "@/lib/prisma";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";
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

/**
 * Stages the "you're registered" bell and emails for a zero-amount event seat on the checkout
 * commit's transaction, so the notice commits, or rolls back, with the join it announces.
 */
export async function stageFreeSeatNoticeTx(
  tx: Tx,
  args: {
    appointmentId: string;
    userId: string;
    appointmentType: "WEBINAR" | "CLASS";
    join: SeatJoin;
  },
): Promise<StagedNotificationBundle> {
  const key = freeSeatRegisteredKey(args.join.participantId, args.join.joinId);
  const learner = await tx.user.findUnique({
    where: { id: args.userId },
    select: { name: true },
  });
  const appointment = await loadAppointmentForEmails(tx, args.appointmentId);
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
}
