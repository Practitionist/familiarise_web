/**
 * The counterparty's answer to a reschedule proposal — the half of the loop
 * #1064 never shipped (#1163). ACCEPTED and DECLINED existed only as enum
 * members: the sole DECLINED writer was the cancel route closing proposals as
 * a side-effect, ACCEPTED only ever arrived as a by-product of the consultant
 * allocating, and the consultee had no way to answer at all while the
 * consultant's toast claimed "the consultee has been asked to accept".
 *
 * Accept mirrors auto-confirm's design: the proposed times go straight to the
 * allocator (`manual` mode, wide lock), which performs the full availability /
 * caps / conflict validation under the correct locks — nothing is written
 * unless it commits. The one difference is consent: auto-confirm requires the
 * times to fall inside published availability because nobody is asked;
 * an explicit accept IS the asking, so the initiator-role gate does not apply.
 *
 * Decline RESTORES. It used to be a status transition and nothing else, and
 * that left a paid booking in the one shape the refunding sweeps select: a
 * whole-booking reschedule puts the parent in PENDING, a decline leaves the
 * released sessions tentative, and the proposal — no longer open — stops being
 * the thing that kept `expireUnallocatedPaidSubscriptions` off it, so a
 * consultant saying "no, not that time" ended with the platform refunding the
 * buyer in full and the sessions sitting in an allocate queue nobody is told
 * about. Restoring is withdraw's and expiry's path, unchanged
 * (`lib/booking/reschedule-restore.ts`); what decline adds is the case where
 * the original time is gone, which parks the parent and says so out loud
 * rather than failing the decline.
 */

import prisma, { type Tx } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import type { EventType } from "@/utils/scheduling-engine/types";
import { allocate } from "@/lib/booking/allocation";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { transitionRescheduleRequest } from "@/lib/booking/transitions";
import { allocationConfirmsMove } from "@/lib/booking/allocation/notify";
import { closeConfirmedProposal } from "@/lib/booking/reschedule-confirm";
import { stageNoticesForFreedWindows } from "@/lib/booking/backup-interest";
import {
  isRestoreMiss,
  parkParentForUnrestoredEnding,
  reportPartialRestore,
  restoreRescheduledBooking,
} from "@/lib/booking/reschedule-restore";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import type { RescheduleOutcomeFields } from "@/lib/novu/workflows";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  attemptRescheduleNotice,
  RESCHEDULE_PARTIES_SELECT,
  rescheduleParties,
  stageRescheduleNotice,
  type StagedRescheduleNotice,
} from "@/lib/booking/reschedule-outcome-notice";

export type RespondOutcome = { done: true } | { done: false; reason: string };

/**
 * A decline's own answer, and the one the route is obliged to believe.
 *
 * `restoredFully` is the restore's MATCHED COUNT, read inside the locked
 * transaction that did the restoring. It was previously re-derived by the route
 * with a `count` AFTER the lock was released, which made the DECLINED/RELEASED
 * code a second, racy opinion about a write that had already committed: another
 * writer landing between the commit and the count could move a slot out from
 * under the sentence, so the toast could announce "your original times have
 * been put back" for a booking whose slots a concurrent cancel had just taken.
 * Two readers of one decision is the defect; there is now one reader, and it is
 * the writer.
 *
 * The `done: false` arm is unchanged: it carries no restore, so it has no
 * `restoredFully` to report and callers branch on `done` first.
 */
export type DeclineOutcome =
  { done: true; restoredFully: boolean } | { done: false; reason: string };

export async function acceptProposal(args: {
  rescheduleRequestId: string;
  eventType: EventType;
  eventId: string;
  resolvedById: string;
  /** The booking's appointment lock the caller holds; the allocator renews it. */
  heldAppointmentLock: ApprovalLock;
}): Promise<RespondOutcome> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: args.rescheduleRequestId },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      proposedTimes: {
        orderBy: { startsAt: "asc" },
        select: { startsAt: true },
      },
    },
  });
  if (!request) return { done: false, reason: "PROPOSAL_NOT_FOUND" };
  if (request.status !== "PENDING_REVIEW") {
    return { done: false, reason: "PROPOSAL_NOT_OPEN" };
  }
  // The status alone does not mean "still answerable": `expireRescheduleProposals`
  // runs hourly, so a lapsed proposal stays PENDING_REVIEW for up to an hour.
  // Honouring the deadline here matters beyond tidiness — expiry is
  // min(now + 72h, earliest released session − 24h), so accepting a lapsed
  // proposal is exactly how a booking lands inside the 24-hour window the
  // reschedule route refuses to move it into.
  //
  // The window between this read and the ACCEPTED write needs no lock of its
  // own: EXPIRED is not in `RESCHEDULE_ALLOWED_FROM.ACCEPTED`, so a cron that
  // wins that race makes the final CAS transition fail rather than accept.
  if (request.expiresAt.getTime() <= Date.now()) {
    return { done: false, reason: "PROPOSAL_EXPIRED" };
  }
  if (request.proposedTimes.length === 0) {
    // A preference-only request (#1065) proposes no concrete times — there is
    // nothing to accept as-is; the consultant answers it by allocating.
    return { done: false, reason: "NO_PROPOSED_TIMES" };
  }

  const result = await allocate({
    eventType: args.eventType,
    eventId: args.eventId,
    heldAppointmentLock: args.heldAppointmentLock,
    mode: "manual",
    slots: request.proposedTimes.map((p) => p.startsAt.toISOString()),
    // #1340 — same exclusion as auto-confirm: the allocator declines every open
    // proposal these released slots carry, and this one is being ACCEPTED, not
    // superseded.
    excludeRescheduleRequestId: request.id,
    actorUserId: args.resolvedById,
    // ACCEPTED commits with the move or not at all.
    inTx: async (tx, moved) => {
      allocationConfirmsMove(tx);
      await closeConfirmedProposal(tx, {
        where: { id: request.id },
        to: "ACCEPTED",
        data: { resolvedById: args.resolvedById },
      });
      // The original times are free now; waitlisters hear in this commit.
      await stageNoticesForFreedWindows(
        tx,
        moved.consultantProfileId,
        moved.freedWindows,
        moved.placed,
      );
    },
  });
  if (!result.success) {
    // Nothing was written; the proposal stays open unless it was closed under us.
    return { done: false, reason: result.errorCode ?? "VALIDATION_FAILED" };
  }

  // PR 2c (audit G2) — the answer finally travels back to the initiator:
  // they proposed, the other party accepted, the booking HAS MOVED. Payload
  // uses the MOVED arm (old = earliest released slot's original time; new =
  // the first proposed time). Fire-and-forget; a Novu outage must not fail
  // the accept.
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: args.rescheduleRequestId },
      select: {
        initiatedById: true,
        appointment: {
          select: {
            id: true,
            organizationId: true,
            appointmentType: true,
            ...RESCHEDULE_PARTIES_SELECT,
          },
        },
        releasedOccurrenceIds: true,
        proposedTimes: {
          orderBy: { startsAt: "asc" },
          take: 1,
          select: { startsAt: true },
        },
      },
    });
    const appt = detail?.appointment;
    const parties = appt ? rescheduleParties(appt) : null;
    const released = detail?.releasedOccurrenceIds?.length
      ? await prisma.appointmentOccurrence.findFirst({
          where: { id: { in: detail.releasedOccurrenceIds } },
          orderBy: { startsAt: "asc" },
          select: { startsAt: true },
        })
      : null;
    if (detail && appt && parties && released && detail.proposedTimes[0]) {
      const { consultantUser, consulteeUser } = parties;
      const recipient = detail.initiatedById;
      const other =
        consulteeUser.id === detail.initiatedById
          ? consultantUser.id
          : consulteeUser.id;
      const staged = await stageRescheduleNotice(prisma, {
        appointment: appt,
        parties,
        userIds: [recipient, other].filter(
          (id, i, arr) => !!id && arr.indexOf(id) === i,
        ),
        dedupeKey: `reschedule-moved:${args.rescheduleRequestId}`,
        variant: {
          outcome: "MOVED",
          oldDateTime: released.startsAt.toISOString(),
          newDateTime: detail.proposedTimes[0].startsAt.toISOString(),
        },
      });
      await attemptRescheduleNotice(staged, EMAIL_BUDGET_MS.REQUEST);
    }
  } catch (notifyErr) {
    await import("@/lib/observability/report")
      .then((m) =>
        m.reportSentryError(
          notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
          {
            subsystem: "bookings",
            op: "reschedule-accept-notify",
            expected: true,
          },
        ),
      )
      .catch(() => {});
  }

  return { done: true };
}

/** The proposal fields the restore and the park need, read with the decline. */
const DECLINE_SELECT = {
  id: true,
  appointmentId: true,
  createdAt: true,
  originStatus: true,
  releasedOccurrenceIds: true,
  appointment: { select: { consultationId: true, subscriptionId: true } },
} as const;

export async function declineProposal(args: {
  rescheduleRequestId: string;
  resolvedById: string;
}): Promise<DeclineOutcome> {
  const { rescheduleRequestId, resolvedById } = args;

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: DECLINE_SELECT,
  });
  if (!request) return { done: false, reason: "PROPOSAL_NOT_FOUND" };

  // #1583 A-P0-04 — the decline now writes occurrence rows, so it serialises on
  // the appointment atom like withdraw does; the transaction opens inside. The
  // respond route takes this lock for accept only, so there is no nesting, and
  // the lock order is unchanged (the appointment atom is the coarsest).
  //
  // ONE GRANT COVERS THE WHOLE DECLINE, including the restore-miss fallback. It
  // used to cover only the first transaction: the miss propagated out of
  // `withAppointmentLock`, whose `finally` released the atom, and the terminal
  // DECLINED plus the park then ran UNLOCKED in the gap. That gap is the window
  // this closes — a concurrent cancel or reschedule could take the appointment
  // between the rollback and the park, so the park's CAS matched nothing and
  // the booking was left PENDING with released sessions: precisely the shape
  // `expireUnallocatedPaidSubscriptions` refunds in full, arrived at by a race
  // rather than by a decision. The fallback is the RARE path, so holding the
  // atom across it costs contention nothing anyone will feel.
  //
  // What did NOT move: the fallback's two writes stay in SEPARATE transactions.
  // The park is bookkeeping and must never be able to veto a human's answer
  // (see the note at the park below) — that argument is about the transaction
  // boundary, not the lock, and one grant can hold two transactions perfectly
  // well. Only the lock is now wider.
  let restored = 0;
  /** Set when the restore could not land, so the decline still has to commit. */
  let restoreMiss: unknown = null;
  let parkedStatus: string | null = null;
  /** Set when another party had already answered this proposal. */
  let answerLost = false;
  /** Staged on the transaction that commits the decline; attempted after it. */
  let declinedNotice: StagedRescheduleNotice | null = null;

  try {
    await withAppointmentLock(request.appointmentId, async () => {
      // The body below takes no Redis lock of its own — every write here is a
      // `tx` call — so it cannot raise a typed lock error, and those rethrown
      // by the OUTER catch below are the atom's own acquisition failures.
      try {
        await prisma.$transaction(async (tx) => {
          // The CAS is the guard: a concurrent accept or expiry answers first and
          // this matches zero rows, so nothing is restored out from under it.
          await transitionRescheduleRequest(tx, {
            where: { id: request.id },
            to: "DECLINED",
            data: { resolvedById },
          });

          try {
            restored = await restoreRescheduledBooking(tx, request, {
              actorUserId: resolvedById,
              reason: "reschedule declined",
              op: "reschedule-decline",
            });
          } catch (err) {
            if (!isRestoreMiss(err)) throw err;
            // The consultant's original time was taken while the proposal was
            // open, so the booking cannot go back to it. Recorded, then
            // rethrown: this transaction rolls back whole — the proposal stays
            // open and nothing moved — and the fallback below commits the
            // DECLINED on its own. Mirrors the expiry sweep's own two-step.
            restoreMiss = err;
            throw err;
          }
          declinedNotice = await stageDeclinedNotice(
            tx,
            request.id,
            resolvedById,
            restored === request.releasedOccurrenceIds.length,
          );
        });
        return;
      } catch (err) {
        // A null `restoreMiss` means the restore never got far enough to be the
        // problem: the proposal's own CAS missed, so another party answered it
        // and that answer wins. Distinguished from a restore miss on purpose —
        // here nothing happened, there the decline has to commit anyway.
        if (restoreMiss === null) {
          if (err instanceof IllegalTransitionError) {
            answerLost = true;
            return;
          }
          throw err;
        }

        // #1846 SM-B15, on the decline edge: the DECLINED stands even though the
        // sessions cannot be restored. Someone decided, and re-offering the
        // proposal because their old time is gone would be asking them the same
        // question again. Committed on its own, exactly as the expiry sweep
        // re-runs its terminal edge once the restore has proved it cannot land.
        try {
          await prisma.$transaction(async (tx) => {
            await transitionRescheduleRequest(tx, {
              where: { id: request.id },
              to: "DECLINED",
              data: { resolvedById },
            });
            declinedNotice = await stageDeclinedNotice(
              tx,
              request.id,
              resolvedById,
              false,
            );
            try {
              parkedStatus = await parkParentForUnrestoredEnding(tx, request, {
                actorUserId: resolvedById,
                reason:
                  "reschedule declined; original time no longer available",
                op: "reschedule-decline-park",
              });
            } catch (parkErr) {
              reportSentryError(parkErr, {
                subsystem: "bookings",
                op: "reschedule-decline-park",
                extra: {
                  rescheduleRequestId,
                  restoreMiss: String(restoreMiss),
                },
              });
            }
          });
        } catch (declineErr) {
          if (declineErr instanceof IllegalTransitionError) {
            answerLost = true;
            return;
          }
          throw declineErr;
        }
        restored = 0;
      }
    });
  } catch (err) {
    // A held lock and an unreachable lock service are the route's answers
    // (423 / 503), not this module's to translate, and not a fault to report.
    if (
      err instanceof AppointmentBusyError ||
      err instanceof BookingLockUnavailableError
    ) {
      throw err;
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-decline",
      // Carries the restore miss when there was one, so a fault raised by the
      // fallback's own commit is still attributable to the original time being
      // gone rather than reading as a bare decline failure.
      extra: {
        rescheduleRequestId,
        ...(restoreMiss === null ? {} : { restoreMiss: String(restoreMiss) }),
      },
    });
    throw err;
  }

  if (answerLost) return { done: false, reason: "PROPOSAL_NOT_OPEN" };

  // Anything short of every released session is a booking that still owes
  // somebody a time, and that is the case an operator has to see: DECLINED's
  // copy asserts the original time is kept, so a stranded booking must not be
  // sent that arm, and a booking left PENDING with released sessions is the
  // shape the refunding sweeps select. The `SystemEvent` row is the durable
  // half — `reportSentryError` alone evaporates, and this is the only trace
  // that the buyer is still owed sessions.
  //
  // `restored` is the restore helper's own MATCHED COUNT, assigned from inside
  // the locked transaction above, so this is the writer's answer rather than a
  // re-read of its effect. That distinction is the point: the route used to
  // recount the rows after the lock was released, and a booking whose slots
  // changed in between got a code describing somebody else's write.
  const restoredFully = restored === request.releasedOccurrenceIds.length;

  if (restoreMiss === null) {
    reportPartialRestore(request, restored, "reschedule-decline");
  }

  if (!restoredFully) {
    const stranded =
      restoreMiss ?? new Error("reschedule-decline: restore was partial");
    reportSentryError(stranded, {
      subsystem: "bookings",
      op: "reschedule-decline-restore-miss",
      // Modelled — the original time being gone is an answer, not a fault class
      // — but warning-level, because a buyer is still owed a session. The expiry
      // sweep reports the same shape the same way.
      expected: true,
      level: "warning",
      extra: {
        rescheduleRequestId,
        appointmentId: request.appointmentId,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
        restored,
        parkedStatus,
      },
    });
    await recordSystemErrorSafe({
      organizationId: null,
      category: "RESCHEDULE",
      summary:
        "Declined reschedule left sessions needing new times; the booking is parked and a person must place them",
      err: stranded,
      context: {
        rescheduleRequestId,
        appointmentId: request.appointmentId,
        consultationId: request.appointment?.consultationId ?? null,
        subscriptionId: request.appointment?.subscriptionId ?? null,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
        restored,
        parkedStatus,
        restoreMiss: restoreMiss !== null,
      },
    });
  }

  // The notice committed with the decline; a failed attempt waits for the relays.
  if (declinedNotice) {
    try {
      await attemptRescheduleNotice(declinedNotice, EMAIL_BUDGET_MS.REQUEST);
    } catch (notifyErr) {
      reportSentryError(
        notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
        {
          subsystem: "bookings",
          op: "reschedule-decline-notify",
          expected: true,
        },
      );
    }
  }

  // The route's DECLINED/RELEASED code and the notification above are both
  // driven by this one `restoredFully`, so the toast the counterparty reads and
  // the toast the initiator gets cannot describe one decline two different ways.
  // Reporting it is also what lets the route stop re-reading the rows: the
  // writer is the authority on what it wrote.
  return { done: true, restoredFully };
}

/**
 * Stages the declined notice on the decline's own transaction, so it commits
 * with the answer: DECLINED when every original time is back, RELEASED when the
 * booking still owes a time. Required for everyone but the person who declined.
 */
async function stageDeclinedNotice(
  tx: Tx,
  rescheduleRequestId: string,
  resolvedById: string,
  restoredFully: boolean,
): Promise<StagedRescheduleNotice | null> {
  const detail = await tx.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      initiatedById: true,
      appointment: {
        select: {
          id: true,
          organizationId: true,
          appointmentType: true,
          ...RESCHEDULE_PARTIES_SELECT,
        },
      },
      releasedOccurrenceIds: true,
    },
  });
  const appt = detail?.appointment;
  const parties = appt ? rescheduleParties(appt) : null;
  if (!detail || !parties || !appt) return null;
  const userIds = [
    detail.initiatedById,
    parties.consultantUser.id,
    parties.consulteeUser.id,
  ].filter((id, i, arr) => arr.indexOf(id) === i);
  // The earliest session the booking still owes, so the copy can name a time:
  // the earliest restored one, or the earliest still released.
  const earliest = await tx.appointmentOccurrence.findFirst({
    where: {
      id: { in: detail.releasedOccurrenceIds },
      completionStatus: restoredFully ? "SCHEDULED" : "RESCHEDULED",
      deletedAt: null,
    },
    orderBy: { startsAt: "asc" },
    select: { startsAt: true },
  });
  const stillOwed = earliest
    ? { oldDateTime: earliest.startsAt.toISOString() }
    : {};
  const variant: RescheduleOutcomeFields = restoredFully
    ? { outcome: "DECLINED", ...stillOwed }
    : { outcome: "RELEASED", ...stillOwed };
  return stageRescheduleNotice(tx, {
    appointment: appt,
    parties,
    userIds,
    dedupeKey: `reschedule-declined:${rescheduleRequestId}:${variant.outcome}`,
    required: {
      kind: "REQUEST_DECLINED",
      recipients: userIds.filter((id) => id !== resolvedById),
    },
    variant,
  });
}
