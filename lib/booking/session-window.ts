import { Refusal } from "@/lib/errors/refusal";

/** Where a booking stands against the clock, as every cancel door reads it. */
export type SessionWindowState = "BEFORE" | "IN_PROGRESS" | "DELIVERED";

/** A session freezes for cancellation this long before it starts. */
export const CANCEL_FREEZE_BEFORE_START_MS = 15 * 60_000;

/** The occurrence fields the window reads; callers pass live (non-deleted) rows. */
export type WindowOccurrence = {
  startsAt: Date;
  endsAt: Date;
  completionStatus: string;
  isTentative?: boolean | null;
};

const DELIVERED_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "UNVERIFIED",
]);

/**
 * A confirmed SCHEDULED session inside [start − 15 min, end] makes the booking
 * IN_PROGRESS. Otherwise a delivered session (held, or past its end and not yet
 * swept) with nothing still owed (a session ahead, a released session, an
 * unscheduled entitlement) makes it DELIVERED. Everything else is BEFORE.
 */
export function cancelWindowState(
  occurrences: readonly WindowOccurrence[],
  now: Date,
  opts: { hasUnscheduledEntitlement?: boolean } = {},
): SessionWindowState {
  const t = now.getTime();
  let delivered = false;
  let owedAhead = false;
  for (const o of occurrences) {
    const start = o.startsAt.getTime();
    const end = o.endsAt.getTime();
    if (o.completionStatus === "SCHEDULED" && !o.isTentative) {
      if (t >= start - CANCEL_FREEZE_BEFORE_START_MS && t <= end) {
        return "IN_PROGRESS";
      }
      if (end < t) delivered = true;
      else owedAhead = true;
    } else if (o.completionStatus === "RESCHEDULED") {
      // A released session awaiting its new time is still owed to the buyer.
      owedAhead = true;
    } else if (DELIVERED_STATUSES.has(o.completionStatus)) {
      delivered = true;
    }
  }
  if (owedAhead || opts.hasUnscheduledEntitlement) return "BEFORE";
  return delivered ? "DELIVERED" : "BEFORE";
}

/** The refusal a cancel door answers for a frozen window, or null when it may proceed. */
export function cancelWindowRefusal(
  state: SessionWindowState,
  context?: Record<string, unknown>,
  /** The host settles a session under way from what happened, not by cancelling it. */
  audience: "buyer" | "host" = "buyer",
): Refusal | null {
  if (state === "IN_PROGRESS") {
    return new Refusal({
      code: "SESSION_IN_PROGRESS",
      httpStatus: 409,
      userMessage:
        audience === "host"
          ? "This session is in progress — end the call and we'll settle it from what happened."
          : "This session starts in less than 15 minutes or is already under way, so it can't be cancelled now. If something goes wrong, report a problem from the booking after it ends.",
      context,
    });
  }
  if (state === "DELIVERED") {
    return new Refusal({
      code: "SESSION_ALREADY_DELIVERED",
      httpStatus: 409,
      userMessage:
        "This session has already taken place, so the booking can't be cancelled. If something went wrong, report a problem from the booking.",
      context,
    });
  }
  return null;
}
