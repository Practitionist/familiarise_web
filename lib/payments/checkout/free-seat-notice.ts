// The booked notice for a free event seat, which no capture confirms.

import prisma, { type Tx } from "@/lib/prisma";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import { reportSentryError } from "@/lib/observability/report";
import {
  loadAppointmentForEmails,
  prepareBookedEmails,
  stageBookedBells,
  stageBookedEmails,
  type AppointmentForEmails,
  type Booker,
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

/** A free seat's notice, read and rendered before the commit opens, so the commit only inserts its rows. */
export interface PreparedSeatNotice {
  booker: Booker;
  appointment: AppointmentForEmails;
  emails: PreparedSpecEmails | null;
}

/**
 * Reads the booking and renders the booked email outside any transaction. Null when the
 * read fails, and the commit then reads and renders in its own transaction instead.
 */
export async function prepareFreeSeatNotice(args: {
  appointmentType: "WEBINAR" | "CLASS";
  eventId: string;
  userId: string;
}): Promise<PreparedSeatNotice | null> {
  try {
    const event =
      args.appointmentType === "WEBINAR"
        ? await prisma.webinar.findUnique({
            where: { id: args.eventId },
            select: { appointment: { select: { id: true } } },
          })
        : await prisma.class.findUnique({
            where: { id: args.eventId },
            select: { appointment: { select: { id: true } } },
          });
    const appointmentId = event?.appointment?.id;
    const learner = await prisma.user.findUnique({
      where: { id: args.userId },
      select: { name: true },
    });
    const appointment = appointmentId
      ? await loadAppointmentForEmails(prisma, appointmentId)
      : null;
    if (!learner || !appointment) return null;
    const booker = { userId: args.userId, user: { name: learner.name } };
    return {
      booker,
      appointment,
      emails: await prepareBookedEmails(
        booker,
        appointment,
        args.appointmentType,
      ),
    };
  } catch (error) {
    reportSentryError(error, {
      subsystem: "payments",
      op: "checkout.free-seat-notice.prepare",
      level: "warning",
    });
    return null;
  }
}

/** The notice's reads on the commit's transaction, for a preparation that did not happen. */
async function readSeatNoticeTx(
  tx: Tx,
  args: { appointmentId: string; userId: string },
): Promise<PreparedSeatNotice | null> {
  const learner = await tx.user.findUnique({
    where: { id: args.userId },
    select: { name: true },
  });
  const appointment = await loadAppointmentForEmails(tx, args.appointmentId);
  if (!learner || !appointment) return null;
  return {
    booker: { userId: args.userId, user: { name: learner.name } },
    appointment,
    emails: null,
  };
}

/**
 * Stages the "you're registered" bell and emails for a zero-amount event seat on the checkout
 * commit's transaction, so the notice commits, or rolls back, with the join it announces.
 * The join id only keys the bell; the email was rendered before the commit opened.
 */
export async function stageFreeSeatNoticeTx(
  tx: Tx,
  args: {
    appointmentId: string;
    userId: string;
    appointmentType: "WEBINAR" | "CLASS";
    join: SeatJoin;
    prepared: PreparedSeatNotice | null;
  },
): Promise<StagedNotificationBundle> {
  const key = freeSeatRegisteredKey(args.join.participantId, args.join.joinId);
  // Only a preparation that failed, or one for another appointment, reads and renders here.
  const ready =
    args.prepared?.appointment.id === args.appointmentId
      ? args.prepared
      : await readSeatNoticeTx(tx, args);
  if (!ready) return {};
  const { booker, appointment } = ready;
  const emails = await stageBookedEmails(
    tx,
    booker,
    appointment,
    args.appointmentType,
    ready.emails,
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
