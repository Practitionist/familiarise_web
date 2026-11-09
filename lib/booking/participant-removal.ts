/**
 * A host or co-host removing an attendee from a webinar or class for conduct.
 *
 * Postgres decides first, in one Serializable transaction: the seat goes to
 * CANCELLED (CAS on live statuses), a ParticipantRemoval row records who and
 * why, a support case opens for the attendee, and the seat's earnings are held.
 * No refund is made here; support decides it (or the review sweep refunds in
 * full when support misses its deadline). Stream follows after the commit: the
 * attendee is kicked and blocked from open calls and removed from the event
 * channel, with failures queued on StreamRevocationRetry.
 *
 * A no-fault removal (a mistaken enrolment) stays `leaveEventSeat`, which refunds
 * in full at once.
 */

import { Prisma } from "@prisma/client";
import type {
  ParticipantRemovalActorRole,
  ParticipantRemovalReason,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { scheduleAfter } from "@/lib/api/after-safe";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { holdPaymentForCase } from "@/lib/support/case-holds";
import { openRemovalCaseTx } from "@/lib/support/removal-case";
import {
  enqueueCallKickRetry,
  kickUserFromAppointmentCalls,
  revokeEndedEventChatAccess,
} from "@/lib/stream/access-revocation";
import {
  renewAppointmentLock,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { PARTICIPANT_REMOVAL_REASON_LABELS } from "@/schemas/participant-removal";
import { BookingRuleError } from "./booking-rule-error";
import {
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
} from "./event-waitlist";
import { releaseParticipant } from "./participants";

export interface ConductRemovalInput {
  appointmentId: string;
  targetUserId: string;
  actor: { userId: string; role: ParticipantRemovalActorRole };
  reason: ParticipantRemovalReason;
  note?: string | null;
}

export interface ConductRemovalResult {
  removalId: string;
  caseId: string;
  caseReference: string;
  /** False when the seat had no payment to hold, or a payout was already being sent. */
  earningsHeld: boolean;
}

/**
 * Removes the attendee and starts the review. Returns null when there was no
 * live attendee seat (a repeat request is a no-op). Throws BookingRuleError
 * when the appointment is not a webinar or class.
 */
export async function removeParticipantForConduct(
  input: ConductRemovalInput,
): Promise<ConductRemovalResult | null> {
  const appointment = await prisma.appointment.findFirst({
    where: { id: input.appointmentId, deletedAt: null },
    select: {
      id: true,
      webinar: {
        select: { id: true, webinarPlan: { select: { title: true } } },
      },
      class: { select: { id: true, classPlan: { select: { title: true } } } },
    },
  });
  const event = appointment?.webinar
    ? {
        kind: "webinar" as const,
        id: appointment.webinar.id,
        title: appointment.webinar.webinarPlan?.title ?? null,
      }
    : appointment?.class
      ? {
          kind: "class" as const,
          id: appointment.class.id,
          title: appointment.class.classPlan?.title ?? null,
        }
      : null;
  if (!appointment || !event) {
    throw new BookingRuleError(
      "EVENT_NOT_FOUND",
      "Only a webinar or class attendee can be removed this way.",
      404,
    );
  }

  // Outside the retry, so a retried transaction re-stages the same notice keys.
  const now = new Date();
  const note = input.note?.trim() || null;
  const done = await withAppointmentLock(appointment.id, (lock) =>
    withSerializableRetry(async () => {
      await renewAppointmentLock(lock);
      return prisma.$transaction(
        async (tx) => {
          const released = await releaseParticipant(tx, {
            appointmentId: appointment.id,
            userId: input.targetUserId,
            role: "CONSULTEE",
          });
          if (released === 0) return null;

          const removal = await tx.participantRemoval.upsert({
            where: {
              appointmentId_userId: {
                appointmentId: appointment.id,
                userId: input.targetUserId,
              },
            },
            create: {
              appointmentId: appointment.id,
              userId: input.targetUserId,
              removedByUserId: input.actor.userId,
              actorRole: input.actor.role,
              reason: input.reason,
              note,
            },
            update: {
              removedByUserId: input.actor.userId,
              actorRole: input.actor.role,
              reason: input.reason,
              note,
              status: "PENDING_REVIEW",
              decidedAt: null,
            },
            select: { id: true },
          });

          const supportCase = await openRemovalCaseTx(
            tx,
            {
              appointmentId: appointment.id,
              removedUserId: input.targetUserId,
              actorUserId: input.actor.userId,
              eventTitle: event.title,
              reasonLabel: PARTICIPANT_REMOVAL_REASON_LABELS[input.reason],
              note,
            },
            now,
          );
          await tx.participantRemoval.update({
            where: { id: removal.id },
            data: { supportCaseId: supportCase.id },
          });

          const earningsHeld = await holdSeatEarnings(tx, {
            appointmentId: appointment.id,
            userId: input.targetUserId,
            caseId: supportCase.id,
          });
          const seatOpened = await stageSeatOpenedNotices(
            tx,
            appointment.id,
            now,
          );
          return { removal, supportCase, earningsHeld, seatOpened };
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
    "participant-removal.seat-opened",
  );
  // The live disruptor goes first; chat access follows and queues its own retry.
  if (
    !(await kickUserFromAppointmentCalls(appointment.id, input.targetUserId))
  ) {
    await enqueueCallKickRetry(appointment.id, input.targetUserId);
  }
  await revokeEndedEventChatAccess(event.kind, event.id, [input.targetUserId]);

  return {
    removalId: done.removal.id,
    caseId: done.supportCase.id,
    caseReference: done.supportCase.referenceNumber,
    earningsHeld: done.earningsHeld,
  };
}

/**
 * Freezes the seat's earnings for the removal case. A payment another refund
 * door already owes is left alone (the money is moving), and a payout already
 * being sent cannot be held: the case still opens and staff see the note.
 */
async function holdSeatEarnings(
  tx: Tx,
  args: { appointmentId: string; userId: string; caseId: string },
): Promise<boolean> {
  const payment = await tx.payment.findFirst({
    orderBy: { createdAt: "asc" },
    where: {
      userId: args.userId,
      appointmentId: args.appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: { id: true, refundOwedKey: true },
  });
  if (!payment || payment.refundOwedKey) return false;
  const note = "Held while support reviews a host's removal of the attendee";
  try {
    await holdPaymentForCase(tx, {
      caseId: args.caseId,
      paymentId: payment.id,
      note,
    });
  } catch (error) {
    if (!(error instanceof OpsRefusal)) throw error;
    const { messageSeq } = await tx.supportCase.update({
      where: { id: args.caseId },
      data: { messageSeq: { increment: 1 }, lastMessageAt: new Date() },
      select: { messageSeq: true },
    });
    await tx.supportCaseMessage.create({
      data: {
        caseId: args.caseId,
        seq: messageSeq,
        sender: "SYSTEM",
        isInternal: true,
        body: `Earnings hold not placed (${error.code}): ${error.message}`,
      },
    });
    return false;
  }
  await tx.supportCaseEvent.create({
    data: {
      caseId: args.caseId,
      actorId: null,
      kind: "HOLD_APPLIED",
      toValue: payment.id,
      note,
    },
  });
  return true;
}
