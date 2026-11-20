/**
 * The seat release, review case, earnings hold and Stream intents commit together on tx.
 * Stream work follows the commit; the removal itself refunds nothing.
 */

import { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  holdSeatEarningsTx,
  openOrJoinConductRemovalCaseTx,
} from "@/lib/support/conduct-removal-case";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  persistConductBlockInTx,
  persistSeatRevocationInTx,
  revokeEndedSeatAccess,
  syncConductCallBlock,
} from "@/lib/stream/access-revocation";
import { withEventSeatLock } from "./event-seat-lock";
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
import { notifySeatRemoved } from "./seat-removed-notice";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { CONDUCT_REMOVAL_REVIEW_HOURS } from "@/lib/support/conduct-removal-state";

/** What the removed attendee's notice says after "removed you": the host's reason, the case and the 72 hours. */
export function removalNote(
  reasonLabel: string,
  note: string | null,
  caseReference: string,
): string {
  const why = note ? `${reasonLabel} (${note})` : reasonLabel;
  return `Reason: ${why}. Support case ${caseReference} decides within ${CONDUCT_REMOVAL_REVIEW_HOURS} hours; reply there with your side.`;
}

/** A unique key a concurrent write took first: a typed 409 the organiser can retry, never a 500. */
function removalConflict(): BookingRuleError {
  return new BookingRuleError(
    "REMOVAL_CONFLICT",
    "This attendee's removal changed while you were saving it. Reload the attendee list and try again.",
    409,
  );
}

interface ConductRemovalInput {
  appointmentId: string;
  targetUserId: string;
  actorUserId: string;
  reason: ConductRemovalReason;
  note?: string | null;
  /** The remover's authority, re-read on `tx` under the lock: a co-host revoked meanwhile is refused. */
  authorizeTx: (tx: Tx) => Promise<boolean>;
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

/** Null when no live seat is left, so a repeat is a no-op; serialised on the event's appointment lock. */
export async function removeAttendeeForConduct(
  input: ConductRemovalInput,
): Promise<ConductRemovalResult | null> {
  const event = await removableEvent(input.appointmentId);
  const note = input.note?.trim() || null;
  const done = await withEventSeatLock(input.appointmentId, (renew) => {
    // Under the lock, which every lift also takes, so no lift lands between this instant and
    // the write; outside the retry, so a retried transaction re-stages the same notice keys.
    const now = new Date();
    return withSerializableRetry(async () => {
      await renew();
      return prisma.$transaction(
        async (tx) => {
          if (!(await input.authorizeTx(tx))) {
            throw new BookingRuleError(
              "REMOVAL_NOT_ALLOWED",
              "Only the host or a co-host can remove attendees.",
              403,
            );
          }
          const seatWhere = {
            appointmentId: input.appointmentId,
            ...liveParticipant(input.targetUserId),
            role: "CONSULTEE" as const,
          };
          const released = await releaseParticipant(tx, seatWhere, {
            data: { removedByUserId: input.actorUserId },
            history: {
              reason: "conduct_removal",
              actorUserId: input.actorUserId,
            },
          });
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
          const supportCase = await openOrJoinConductRemovalCaseTx(
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
    });
  }).catch((error: unknown) => {
    throw isUniqueViolation(error) ? removalConflict() : error;
  });
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
      notifySeatRemoved({
        appointmentId: input.appointmentId,
        attendeeUserId: input.targetUserId,
        removal: {
          note: removalNote(
            CONDUCT_REMOVAL_REASON_LABELS[input.reason],
            note,
            done.supportCase.referenceNumber,
          ),
          href: supportRequestHref(
            caseKeyOf({ kind: "case", id: done.supportCase.id }),
          ),
        },
      }),
    "conduct-removal.removed-notice",
  );
  return {
    caseId: done.supportCase.id,
    caseReference: done.supportCase.referenceNumber,
    earningsHeld: done.earningsHeld,
  };
}
