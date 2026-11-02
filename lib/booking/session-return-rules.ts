/**
 * The rules for returning one subscription session to the plan, shared by the
 * route's guards and the button's disabled tooltip. Prisma-free: client
 * components import it.
 */

/** A session can be returned only while it starts at least this far ahead. */
export const RETURN_NOTICE_HOURS = 24;
/** Sessions one plan may return; `subscription_sessions_returned_range` enforces it. */
export const RETURN_CAP = 2;
/** Each return moves the plan end (`planEndsAt`) this many days later. */
const RETURN_EXTENSION_DAYS = 7;
/** The `BookingStatusHistory.reason` of the occurrence a return released. */
export const RETURN_HISTORY_REASON = "RETURNED_TO_PLAN";

const HOUR_MS = 3_600_000;
export const RETURN_EXTENSION_MS = RETURN_EXTENSION_DAYS * 24 * HOUR_MS;

type ReturnBlock = "WINDOW_CLOSED" | "CAP_REACHED" | "RESCHEDULE_OPEN";

/** Why this session cannot be returned now, or null when it can. */
export function returnBlock(args: {
  startsAt: Date | string;
  now: Date;
  sessionsReturned: number;
  rescheduleOpen: boolean;
}): ReturnBlock | null {
  if (args.sessionsReturned >= RETURN_CAP) return "CAP_REACHED";
  if (args.rescheduleOpen) return "RESCHEDULE_OPEN";
  const startsAt = new Date(args.startsAt).getTime();
  if (startsAt - args.now.getTime() < RETURN_NOTICE_HOURS * HOUR_MS) {
    return "WINDOW_CLOSED";
  }
  return null;
}

export const RETURN_BLOCK_COPY: Record<ReturnBlock, string> = {
  WINDOW_CLOSED:
    "This session starts in less than 24 hours, so it can't go back to your plan. If you miss it, it counts as delivered.",
  CAP_REACHED: "You've already returned 2 sessions to this plan.",
  RESCHEDULE_OPEN:
    "A reschedule is waiting for an answer on this plan. Return a session once it's settled.",
};

export const RETURN_CONFIRM_COPY =
  "This session goes back into your plan to book again. Your plan is extended by 7 days. You can do this twice per plan.";
