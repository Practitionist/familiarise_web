import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";

/** Whether an open move's deadline has passed: from then on the original stands. */
export function moveHasLapsed(
  expiresAt: Date | string,
  now: Date = new Date(),
): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

type LapsableMove = {
  expiresAt: Date | string;
  originStatus?: string | null;
};

type LapsableAppointment = {
  rescheduleRequests?: ReadonlyArray<LapsableMove> | null;
  occurrences?: ReadonlyArray<{
    isTentative?: boolean | null;
    completionStatus?: string | null;
    deletedAt?: Date | string | null;
  }> | null;
};

/** The statuses a restore writes back (`restoreTargetFor`); any other origin leaves the parent as it is. */
export const RESTORABLE_ORIGINS = ["APPROVED", "APPROVED_PENDING_PAYMENT"];
const RESTORABLE = new Set(RESTORABLE_ORIGINS);

function lapsedMoveOf(
  appointment: LapsableAppointment | null | undefined,
  now: Date,
): LapsableMove | null {
  const open = appointment?.rescheduleRequests?.[0];
  return open && moveHasLapsed(open.expiresAt, now) ? open : null;
}

function parentStatus<S>(status: S, move: LapsableMove): S | string {
  return move.originStatus && RESTORABLE.has(move.originStatus)
    ? move.originStatus
    : status;
}

function restoredParent<P extends { status?: unknown } | null | undefined>(
  parent: P,
  move: LapsableMove,
): P {
  return parent
    ? { ...parent, status: parentStatus(parent.status, move) }
    : parent;
}

/**
 * A booking read as of now: a lapsed open move shows its released sessions
 * back where they were, its parent at the status the restore writes, and no
 * proposal. Read-time only; nothing is written.
 */
export function withLapsedMoveRestored<
  A extends LapsableAppointment & {
    consultation?: { status?: unknown } | null;
    subscription?: { status?: unknown } | null;
  },
>(appointment: A, now: Date = new Date()): A {
  const move = lapsedMoveOf(appointment, now);
  if (!move) return appointment;
  return {
    ...appointment,
    rescheduleRequests: [],
    occurrences: appointment.occurrences?.map((row) =>
      isReleasedForReschedule(row)
        ? { ...row, completionStatus: "SCHEDULED", isTentative: false }
        : row,
    ),
    ...("consultation" in appointment
      ? { consultation: restoredParent(appointment.consultation, move) }
      : {}),
    ...("subscription" in appointment
      ? { subscription: restoredParent(appointment.subscription, move) }
      : {}),
  };
}

/** The same view for a request read with its appointment under it (the learner's reads). */
export function withLapsedRequestRestored<
  R extends { status?: unknown; appointment?: LapsableAppointment | null },
>(request: R, now: Date = new Date()): R {
  const move = lapsedMoveOf(request.appointment, now);
  if (!move || !request.appointment) return request;
  return {
    ...restoredParent(request, move),
    appointment: withLapsedMoveRestored(request.appointment, now),
  };
}
