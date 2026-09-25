/**
 * #1819 — when a learner may join a class batch and what a late join costs;
 * pure, so the checkout guard, the batch cards and the invoice line agree.
 */

import type { OccurrenceCompletionStatus } from "@prisma/client";

export interface EnrolmentSession {
  ordinal?: number | null;
  startsAt: Date | string;
  completionStatus: OccurrenceCompletionStatus | string;
  deletedAt?: Date | string | null;
}

export interface EnrolmentQuote {
  N: number;
  /** Sessions that have not started yet, and that a seat bought now pays for. */
  remaining: number;
  /** The ordinal of the next session to start. */
  nextOrdinal: number;
  /** The last ordinal a learner may still join before, after clamping. */
  cutoff: number;
  /** The pre-tax base in paise; the full price for an on-time join. */
  basePaise: number;
  isLateJoin: boolean;
}

export type OpenClassEnrolment = { state: "open" } & EnrolmentQuote;

export type ClassEnrolment =
  | { state: "unscheduled"; N: number }
  | OpenClassEnrolment
  | ({ state: "closed" } & EnrolmentQuote);

// A released row (RESCHEDULED) is a session awaiting its new time, not one that ran.
const NOT_STARTED_STATUSES = new Set<string>(["CANCELLED", "RESCHEDULED"]);

/** The batch's enrolment state and price at `now`. */
export function classEnrolmentFrom(args: {
  pricePaise: number | bigint;
  N: number;
  lateJoinUntilSession: number | null | undefined;
  sessions: EnrolmentSession[];
  now: Date;
}): ClassEnrolment {
  const live = args.sessions.filter((s) => !s.deletedAt);
  const N = args.N > 0 ? args.N : live.length;
  if (live.length === 0 || N === 0) return { state: "unscheduled", N };
  const key = (s: EnrolmentSession) =>
    s.ordinal ?? new Date(s.startsAt).getTime();
  const isPast = (s: EnrolmentSession) =>
    new Date(s.startsAt).getTime() <= args.now.getTime();
  // A cancelled past session is gone for a new seat unless its make-up is ahead.
  const madeUpAhead = new Set(
    live
      .filter(
        (s) => !isPast(s) && !NOT_STARTED_STATUSES.has(s.completionStatus),
      )
      .map(key),
  );
  // Remaining = N minus the sessions that have begun, so a session awaiting
  // its new time is still sold rather than silently closing enrolment.
  const started = new Set(
    live
      .filter(
        (s) =>
          isPast(s) &&
          (!NOT_STARTED_STATUSES.has(s.completionStatus) ||
            (s.completionStatus === "CANCELLED" && !madeUpAhead.has(key(s)))),
      )
      .map(key),
  );
  const remaining = Math.max(0, N - started.size);
  const nextOrdinal = N - remaining + 1;
  const cutoff = Math.min(Math.max(args.lateJoinUntilSession ?? 1, 1), N);
  const isLateJoin = remaining < N;
  const basePaise = isLateJoin
    ? Number((BigInt(args.pricePaise) * BigInt(remaining)) / BigInt(N))
    : Number(args.pricePaise);
  return {
    state: remaining > 0 && nextOrdinal <= cutoff ? "open" : "closed",
    N,
    remaining,
    nextOrdinal,
    cutoff,
    basePaise,
    isLateJoin,
  };
}

/** "Sessions 3–8 of 8" — the sessions a seat bought, for the invoice line and the cards. */
export function sessionsBoughtLabel(sessionsPurchased: number, N: number) {
  const first = N - sessionsPurchased + 1;
  return first >= N ? `Session ${N} of ${N}` : `Sessions ${first}–${N} of ${N}`;
}
