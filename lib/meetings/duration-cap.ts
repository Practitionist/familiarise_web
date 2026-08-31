/**
 * How long Stream should let a call run before ending it server-side.
 *
 * A pure policy calculation, in its own module rather than inside the
 * `"use server"` action that uses it — so it can be tested without dragging
 * Prisma and the Stream client into the test process, and so the reasoning
 * below has one home.
 */
import {
  CONSULTANT_JOIN_WINDOW_MS,
  DEFAULT_MEETING_DURATION_MS,
} from "@/lib/appointments/slots";

/**
 * Grace added on top of the booked run before Stream's own duration cap fires.
 *
 * Matches `REJOIN_GRACE_MS` in `lib/meetings/access.ts`. The server already
 * admits a rejoin for thirty minutes past the scheduled end, and a hard cap
 * that expired inside that window would refuse the reconnection the join gate
 * had just authorised.
 */
const CALL_DURATION_GRACE_MS = 30 * 60 * 1000;

/**
 * Floor and ceiling on the computed cap.
 *
 * The floor exists because the cap is derived from data that can be missing or
 * wrong — a null call profile, a zero-length slot — and a cap that is too SHORT
 * ends a paid session early, which is the failure mode #1160 warns about. The
 * ceiling exists because a corrupt booking should not be able to disable the
 * bill bound entirely; twelve hours is far past any real consultation and still
 * finite.
 */
const MIN_CALL_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_CALL_DURATION_MS = 12 * 60 * 60 * 1000;

/**
 * How long Stream should let a session run before ending it server-side.
 *
 * Generous by construction. The timer counts from FIRST JOIN, not from
 * `starts_at`, so every minute someone can legitimately be in the room early
 * has to be inside the budget or the cap eats the end of a paid session.
 *
 * booked run  +  earliest legitimate arrival  +  overrun grace
 *
 * The middle term is `CONSULTANT_JOIN_WINDOW_MS`, the wider of the two windows
 * — the consultant can arrive 15 minutes before the consultee. The last term
 * matches the server's own `REJOIN_GRACE_MS`, so the cap cannot expire while
 * `lib/meetings/access.ts` still considers a rejoin valid; a timer that fires
 * inside the window the join gate is still honouring would be the worst of both.
 *
 * Clamped at both ends. The floor stops a mis-derived run (a null profile, a
 * zero-length slot) from producing a cap short enough to end a real session,
 * and the ceiling keeps a corrupt or absurd booking from disabling the bill
 * bound this exists to provide.
 */
export function resolveMaxCallDurationSeconds(
  callProfile: { endsAt: Date } | null,
  startsAt: Date,
): number {
  const bookedMs = callProfile
    ? Math.max(callProfile.endsAt.getTime() - startsAt.getTime(), 0)
    : DEFAULT_MEETING_DURATION_MS;

  const budgetMs =
    bookedMs + CONSULTANT_JOIN_WINDOW_MS + CALL_DURATION_GRACE_MS;

  const clamped = Math.min(
    Math.max(budgetMs, MIN_CALL_DURATION_MS),
    MAX_CALL_DURATION_MS,
  );
  return Math.floor(clamped / 1000);
}
