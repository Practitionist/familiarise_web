/**
 * Confirming a trial reschedule. A trial is one session, so it has no
 * allocator: the reschedule route releases it (RESCHEDULED, tentative) and
 * opens the booking's one `RescheduleRequest` carrying exactly one new window,
 * and this module moves the released session onto that window when the
 * request is confirmed — by auto-confirm for a consultee proposal inside the
 * expert's open hours, or by the counterparty's Accept. Decline, withdraw and
 * expiry restore the original time through `restoreRescheduledBooking`, like
 * every other booking.
 */
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { SlotLockError } from "@/utils/errors/SlotLockError";
import prisma, { type Tx } from "@/lib/prisma";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { reportSentryError } from "@/lib/observability/report";
import { stageAppointmentRescheduledEmail } from "@/lib/email/senders/booking";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { isTooSoonFor } from "@/lib/booking/lead-time";
import { bookedSessionMinutes } from "@/lib/appointments/occurrences";
import { closeConfirmedProposal } from "@/lib/booking/reschedule-confirm";
import { mayAutoConfirm } from "@/lib/booking/reschedule-proposals";
import {
  RESCHEDULE_PARTIES_SELECT,
  rescheduleParties,
} from "@/lib/booking/reschedule-outcome-notice";
import { ReleasedSessionsSchema } from "@/lib/booking/released-sessions";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { lockTrialPick, lockTrialPickInTx } from "@/lib/trials/book-trial";
import { trialWindowRefusal } from "@/lib/trials/slot-check";

export type TrialConfirmOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: string; takenSlotStarts?: string[] };

/** A committed move, carrying the trial-moved notice staged with it. */
type MoveOutcome = { confirmed: true; notice: TrialMovedNotice | null };

const ATOM_MS = 30 * 60_000;

/**
 * The proposed 30-minute atoms as one contiguous window, or null when they do
 * not form one. A trial moves as a whole, so its new time is a single run.
 */
export function proposedTrialWindow(
  atoms: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
): { startsAt: Date; endsAt: Date } | null {
  if (atoms.length === 0) return null;
  const sorted = [...atoms].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startsAt.getTime() !== sorted[i - 1].endsAt.getTime()) {
      return null;
    }
  }
  return { startsAt: sorted[0].startsAt, endsAt: sorted.at(-1)!.endsAt };
}

/** Thrown inside the move to roll it back with a typed reason. */
class TrialMoveRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TrialMoveRefused";
  }
}

/**
 * Move the released trial session onto the proposal's window and close the
 * proposal (`AUTO_ACCEPTED` or `ACCEPTED`) in one transaction, under the
 * appointment lock, the consultee lock and the window's slot atoms. The window
 * must be the trial's length, at least the reschedule lead away, inside the
 * expert's open hours and free on both calendars; anything else writes nothing
 * and answers a reason the reschedule proposal policy already speaks
 * (`TIMES_TAKEN`, `NO_AVAILABILITY`, `VALIDATION_FAILED`, ...).
 */
export async function confirmTrialProposal(args: {
  rescheduleRequestId: string;
  to: "AUTO_ACCEPTED" | "ACCEPTED";
  resolvedById?: string;
  /** The appointment lock when the caller already holds it; taken here otherwise. */
  heldAppointmentLock?: ApprovalLock;
  now?: Date;
}): Promise<TrialConfirmOutcome> {
  const now = args.now ?? new Date();
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: args.rescheduleRequestId },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      initiatorRole: true,
      appointmentId: true,
      releasedOccurrenceIds: true,
      proposedTimes: { select: { startsAt: true, endsAt: true } },
      appointment: {
        select: {
          // The session being moved carries the length the trial was sold at.
          occurrences: {
            select: {
              startsAt: true,
              endsAt: true,
              completionStatus: true,
              deletedAt: true,
            },
          },
          trial: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
              consulteeProfile: { select: { userId: true } },
              subscriptionPlan: { select: { trialDurationMinutes: true } },
            },
          },
        },
      },
    },
  });
  if (!request) return { confirmed: false, reason: "PROPOSAL_NOT_FOUND" };
  if (request.status !== "PENDING_REVIEW") {
    return { confirmed: false, reason: "PROPOSAL_NOT_OPEN" };
  }
  if (args.to === "AUTO_ACCEPTED" && !mayAutoConfirm(request.initiatorRole)) {
    return { confirmed: false, reason: "CONSULTANT_INITIATED" };
  }
  if (request.expiresAt.getTime() <= now.getTime()) {
    return { confirmed: false, reason: "PROPOSAL_EXPIRED" };
  }
  if (request.proposedTimes.length === 0) {
    return { confirmed: false, reason: "NO_PROPOSED_TIMES" };
  }
  const trial = request.appointment?.trial;
  const window = proposedTrialWindow(request.proposedTimes);
  const trialMinutes = trial
    ? (bookedSessionMinutes(request.appointment?.occurrences ?? []) ??
      trial.subscriptionPlan.trialDurationMinutes)
    : 0;
  if (
    !trial ||
    !window ||
    window.endsAt.getTime() - window.startsAt.getTime() !==
      trialMinutes * 60_000 ||
    (window.endsAt.getTime() - window.startsAt.getTime()) % ATOM_MS !== 0
  ) {
    return { confirmed: false, reason: "VALIDATION_FAILED" };
  }
  if (
    isTooSoonFor(
      "reschedule",
      { settled: true },
      window.startsAt.getTime(),
      now.getTime(),
    )
  ) {
    return { confirmed: false, reason: "TOO_CLOSE_TO_START" };
  }

  const consulteeUserId = trial.consulteeProfile.userId;
  const move = async (): Promise<MoveOutcome> => {
    const buyerProfile = await prisma.consultantProfile.findUnique({
      where: { userId: consulteeUserId },
      select: { id: true },
    });
    const release = await lockTrialPick({
      consulteeUserId,
      consultantProfileId: trial.consultantProfileId,
      buyerConsultantProfileId: buyerProfile?.id,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
    });
    try {
      return await prisma.$transaction(async (tx): Promise<MoveOutcome> => {
        await lockTrialPickInTx(
          tx,
          {
            consulteeUserId,
            consultantProfileId: trial.consultantProfileId,
            buyerConsultantProfileId: buyerProfile?.id,
            startsAt: window.startsAt,
            endsAt: window.endsAt,
          },
          () => new TrialMoveRefused("TIMES_TAKEN"),
        );
        await closeConfirmedProposal(tx, {
          where: { id: request.id },
          to: args.to,
          ...(args.resolvedById
            ? { data: { resolvedById: args.resolvedById } }
            : {}),
        });
        const refusal = await trialWindowRefusal(tx, {
          consultantProfileId: trial.consultantProfileId,
          consultantUserId: trial.consultantProfile.userId,
          consulteeUserId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          selfHoldAppointmentIds: [request.appointmentId],
        });
        if (refusal === "OUTSIDE_AVAILABILITY") {
          throw new TrialMoveRefused("NO_AVAILABILITY");
        }
        if (refusal === "SLOT_TAKEN") throw new TrialMoveRefused("TIMES_TAKEN");
        // The released row moves in place, so its meeting and seats survive;
        // the request's releasedSessions keep the original time for the caps.
        const moved = await transitionOccurrenceCompletion(tx, {
          actorUserId: args.resolvedById ?? null,
          appointmentId: request.appointmentId,
          reason: "trial reschedule confirmed",
          where: {
            id: { in: request.releasedOccurrenceIds },
            appointmentId: request.appointmentId,
            deletedAt: null,
          },
          to: "SCHEDULED",
          fromIn: ["RESCHEDULED"],
          data: {
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            isTentative: false,
          },
          allowZero: true,
        });
        if (moved !== 1) throw new TrialMoveRefused("VALIDATION_FAILED");
        const notice =
          args.to === "ACCEPTED"
            ? await stageTrialMovedBells(tx, {
                rescheduleRequestId: request.id,
                newStartsAt: window.startsAt,
                moverId: args.resolvedById,
              })
            : null;
        return { confirmed: true, notice };
      });
    } finally {
      await release();
    }
  };

  let outcome: MoveOutcome;
  try {
    outcome = args.heldAppointmentLock
      ? await move()
      : await withAppointmentLock(request.appointmentId, move);
  } catch (error) {
    if (error instanceof TrialMoveRefused) {
      return {
        confirmed: false,
        reason: error.reason,
        ...(error.reason === "TIMES_TAKEN"
          ? { takenSlotStarts: [window.startsAt.toISOString()] }
          : {}),
      };
    }
    if (isExclusionViolation(error)) {
      return {
        confirmed: false,
        reason: "TIMES_TAKEN",
        takenSlotStarts: [window.startsAt.toISOString()],
      };
    }
    if (error instanceof AllocationConflictError) {
      return { confirmed: false, reason: error.errorCode };
    }
    if (
      error instanceof SlotLockError ||
      error instanceof AppointmentBusyError
    ) {
      return { confirmed: false, reason: "APPOINTMENT_BUSY" };
    }
    if (error instanceof BookingLockUnavailableError) {
      return { confirmed: false, reason: "BOOKING_LOCK_UNAVAILABLE" };
    }
    throw error;
  }

  if (outcome.notice) await flushTrialMovedNotice(outcome.notice);
  return { confirmed: true };
}

interface TrialMovedNotice {
  bells: Array<StagedTrigger | undefined>;
  email: {
    appointmentId: string;
    userIds: string[];
    appointmentType: string;
    oldStartsAt: Date;
    newStartsAt: Date;
    dashboardUrl: string;
  };
}

/**
 * The party who did not make the move hears the trial moved: the bell is
 * staged on the move's transaction, the email after commit.
 */
async function stageTrialMovedBells(
  tx: Tx,
  args: { rescheduleRequestId: string; newStartsAt: Date; moverId?: string },
): Promise<TrialMovedNotice | null> {
  const detail = await tx.rescheduleRequest.findUnique({
    where: { id: args.rescheduleRequestId },
    select: {
      initiatedById: true,
      releasedSessions: true,
      appointment: {
        select: {
          id: true,
          organizationId: true,
          appointmentType: true,
          ...RESCHEDULE_PARTIES_SELECT,
        },
      },
    },
  });
  const appt = detail?.appointment;
  const parties = appt ? rescheduleParties(appt) : null;
  if (!detail || !appt || !parties) return null;
  const released = ReleasedSessionsSchema.safeParse(detail.releasedSessions);
  const first = released.success ? released.data[0] : undefined;
  if (!first) return null;
  const mover = args.moverId ?? detail.initiatedById;
  const userIds = [parties.consultantUser.id, parties.consulteeUser.id].filter(
    (id, i, all) => id !== mover && all.indexOf(id) === i,
  );
  if (userIds.length === 0) return null;
  const oldStartsAt = new Date(first.startsAt);
  const dashboardUrl = notificationHref(appt.organizationId, "appointments");
  const staged = await notifyAppointmentRescheduled(
    userIds,
    {
      ...notificationScope(appt.organizationId),
      appointmentType: appt.appointmentType,
      consultantName: parties.consultantUser.name || "Consultant",
      consulteeName: parties.consulteeUser.name || "Consultee",
      planTitle: parties.planTitle,
      dashboardUrl,
      outcome: "MOVED",
      oldDateTime: oldStartsAt.toISOString(),
      newDateTime: args.newStartsAt.toISOString(),
    },
    { tx, deferAttempt: true },
  );
  return {
    bells: staged.map((row) => row.staged),
    email: {
      appointmentId: appt.id,
      userIds,
      appointmentType: appt.appointmentType,
      oldStartsAt,
      newStartsAt: args.newStartsAt,
      dashboardUrl,
    },
  };
}

/** Stages the email and dispatches the committed bells. Never throws. */
async function flushTrialMovedNotice(notice: TrialMovedNotice): Promise<void> {
  const rows = await stageAppointmentRescheduledEmail(prisma, {
    ...notice.email,
    outcome: "MOVED",
  }).catch((error: unknown) => {
    reportSentryError(error, {
      subsystem: "bookings",
      op: "trial-reschedule-accept-notify",
      expected: true,
    });
    return [];
  });
  await flushNotificationsAfter(
    {
      bells: notice.bells,
      emails: [{ rows, emailType: "APPOINTMENT_RESCHEDULED" }],
    },
    "trial-reschedule-accept",
  );
}
