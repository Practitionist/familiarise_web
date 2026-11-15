/**
 * A host or co-host removing an attendee from a webinar or class for conduct.
 *
 * One Serializable transaction, `tx` everywhere: the seat ends (CAS on its live
 * statuses), a CONDUCT_REMOVAL support case opens for the attendee and records
 * who removed them and why, the seat's earnings are held, and the Stream
 * intents (seat access and the call block) are written. Nothing is refunded
 * here. After the commit the intents are driven; the revocation sweep owns
 * whatever a crash or a Stream failure leaves.
 */

import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  holdSeatEarningsTx,
  openConductRemovalCaseTx,
} from "@/lib/support/conduct-removal-case";
import {
  persistConductBlockInTx,
  persistSeatRevocationInTx,
  revokeEndedSeatAccess,
  syncConductCallBlock,
} from "@/lib/stream/access-revocation";
import {
  renewAppointmentLock,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import {
  CONDUCT_REMOVAL_REASON_LABELS,
  type ConductRemovalReason,
} from "@/schemas/conduct-removal";
import { BookingRuleError } from "./booking-rule-error";
import {
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
} from "./event-waitlist";
import { liveParticipant, releaseParticipant } from "./participants";
import { notifyFreeSeatRemoved } from "./seat-removed-notice";

interface ConductRemovalInput {
  appointmentId: string;
  targetUserId: string;
  actorUserId: string;
  reason: ConductRemovalReason;
  note?: string | null;
}

interface ConductRemovalResult {
  caseId: string;
  caseReference: string;
  /** False when the seat had no payment to hold, or a payout was already being sent. */
  earningsHeld: boolean;
}

async function removableEvent(appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, deletedAt: null },
    select: {
      webinar: { select: { webinarPlan: { select: { title: true } } } },
      class: { select: { classPlan: { select: { title: true } } } },
    },
  });
  const plan =
    appointment?.webinar?.webinarPlan ?? appointment?.class?.classPlan;
  if (!appointment || (!appointment.webinar && !appointment.class)) {
    throw new BookingRuleError(
      "EVENT_NOT_FOUND",
      "Only a webinar or class attendee can be removed this way.",
      404,
    );
  }
  return { title: plan?.title ?? null };
}

/**
 * Removes the attendee and opens the review. Returns null when they hold no
 * live seat (a repeat is a no-op). Serialised with seat leaves, whole-event
 * cancels and the settle sweep on the event's appointment lock.
 */
export async function removeAttendeeForConduct(
  input: ConductRemovalInput,
): Promise<ConductRemovalResult | null> {
  const event = await removableEvent(input.appointmentId);
  // Outside the retry, so a retried transaction re-stages the same notice keys.
  const now = new Date();
  const note = input.note?.trim() || null;
  const done = await withAppointmentLock(input.appointmentId, (lock) =>
    withSerializableRetry(async () => {
      await renewAppointmentLock(lock);
      return prisma.$transaction(
        async (tx) => {
          const seatWhere = {
            appointmentId: input.appointmentId,
            ...liveParticipant(input.targetUserId),
            role: "CONSULTEE" as const,
          };
          const released = await releaseParticipant(tx, seatWhere);
          if (released === 0) return null;
          const seatRevocation = await persistSeatRevocationInTx(
            tx,
            input.appointmentId,
            [input.targetUserId],
          );
          const block = await persistConductBlockInTx(
            tx,
            input.appointmentId,
            input.targetUserId,
          );
          const supportCase = await openConductRemovalCaseTx(
            tx,
            {
              appointmentId: input.appointmentId,
              removedUserId: input.targetUserId,
              actorUserId: input.actorUserId,
              eventTitle: event.title,
              reasonLabel: CONDUCT_REMOVAL_REASON_LABELS[input.reason],
              note,
            },
            now,
          );
          const earningsHeld = await holdSeatEarningsTx(tx, {
            appointmentId: input.appointmentId,
            userId: input.targetUserId,
            caseId: supportCase.id,
            now,
          });
          const seatOpened = await stageSeatOpenedNotices(
            tx,
            input.appointmentId,
            now,
          );
          return {
            supportCase,
            earningsHeld,
            seatOpened,
            seatRevocation,
            block,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      );
    }),
  );
  if (!done) return null;

  await scheduleAfter(
    () => finishSeatOpenedNotices(done.seatOpened),
    "conduct-removal.seat-opened",
  );
  // The live room first, so a disruptor is out before chat and DMs follow.
  await syncConductCallBlock(
    input.appointmentId,
    input.targetUserId,
    done.block,
  );
  await revokeEndedSeatAccess(
    input.appointmentId,
    [input.targetUserId],
    done.seatRevocation,
  );
  await scheduleAfter(
    () =>
      notifyFreeSeatRemoved({
        appointmentId: input.appointmentId,
        attendeeUserId: input.targetUserId,
      }),
    "conduct-removal.removed-notice",
  );
  return {
    caseId: done.supportCase.id,
    caseReference: done.supportCase.referenceNumber,
    earningsHeld: done.earningsHeld,
  };
}
