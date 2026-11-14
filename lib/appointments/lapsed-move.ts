import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";

/** Whether an open move's deadline has passed: from then on the original stands. */
export function moveHasLapsed(
  expiresAt: Date | string,
  now: Date = new Date(),
): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

/**
 * A booking read as of now: a lapsed open move shows its released sessions
 * back where they were and no proposal. Read-time only; nothing is written.
 */
export function withLapsedMoveRestored<
  A extends {
    rescheduleRequests?: ReadonlyArray<{ expiresAt: Date | string }> | null;
    occurrences?: ReadonlyArray<{
      isTentative?: boolean | null;
      completionStatus?: string | null;
      deletedAt?: Date | string | null;
    }> | null;
  },
>(appointment: A, now: Date = new Date()): A {
  const open = appointment.rescheduleRequests?.[0];
  if (!open || !moveHasLapsed(open.expiresAt, now)) return appointment;
  return {
    ...appointment,
    rescheduleRequests: [],
    occurrences: appointment.occurrences?.map((row) =>
      isReleasedForReschedule(row)
        ? { ...row, completionStatus: "SCHEDULED", isTentative: false }
        : row,
    ),
  };
}
