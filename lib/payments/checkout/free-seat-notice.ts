// The booked notice for a free event seat, which no capture confirms.

import prisma from "@/lib/prisma";
import { stageNowAttemptAfter } from "@/lib/novu/stage-then-attempt";
import {
  loadAppointmentForEmails,
  stageBookedBells,
  stageBookedEmails,
} from "@/lib/payments/webhooks/staged-emails";

/** Keyed per seat and join instant, so a rejoin gets its own notice and a re-stage of one join does not. */
export const freeSeatRegisteredKey = (participantId: string, joinedAt: Date) =>
  `seat-registered:${participantId}:${joinedAt.getTime()}`;

/** Stages the "you're registered" bell and emails after a zero-amount event seat commits. */
export async function notifyFreeSeatRegistered(args: {
  appointmentId: string;
  userId: string;
  appointmentType: "WEBINAR" | "CLASS";
}): Promise<void> {
  await stageNowAttemptAfter("checkout.free-seat-booked", () =>
    prisma.$transaction(async (tx) => {
      const seat = await tx.appointmentParticipant.findUnique({
        where: {
          appointmentId_userId: {
            appointmentId: args.appointmentId,
            userId: args.userId,
          },
        },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          user: { select: { name: true } },
        },
      });
      if (seat?.status !== "CONFIRMED") return {};
      const appointment = await loadAppointmentForEmails(
        tx,
        args.appointmentId,
      );
      if (!appointment) return {};
      const booker = { userId: args.userId, user: { name: seat.user.name } };
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
        freeSeatRegisteredKey(seat.id, seat.updatedAt),
      );
      return {
        bells,
        emails: [{ rows: emails, emailType: "APPOINTMENT_BOOKED" }],
      };
    }),
  );
}
