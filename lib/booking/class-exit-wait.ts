/**
 * A class exit waits while any void in the series carries a negative verdict
 * nobody confirmed, so the exit's quote never prices a session that may yet be
 * held. Pure and client-safe: the exit door and the booking page share it.
 */
import type { OccurrenceOutcome } from "@prisma/client";

import { zoneClock } from "@/lib/time/zone-clock";
import { isNegativeMoneyOutcome, reportWindowClosesAt } from "./misses";

export interface ExitWait {
  /** The session whose verdict is being confirmed. */
  sessionStartsAt: Date;
  /** When its report window closes; a disputed or weak verdict waits for ops past it. Null when its verdict time is unknown. */
  settlesBy: Date | null;
}

type VoidRow = {
  startsAt: Date | string;
  completionStatus: string;
  deletedAt?: Date | string | null;
  seatsSettledAt?: Date | string | null;
  outcome: OccurrenceOutcome | null;
  outcomeAt: Date | string | null;
  outcomeConfirmedAt: Date | string | null;
};

/** The series' unconfirmed negative void that settles last, or null when the exit may run now. */
export function exitWaitOf(rows: readonly VoidRow[]): ExitWait | null {
  const pending = rows
    .filter(
      (r) =>
        r.completionStatus === "VOIDED" &&
        !r.deletedAt &&
        !r.seatsSettledAt &&
        isNegativeMoneyOutcome(r.outcome) &&
        !r.outcomeConfirmedAt,
    )
    .map((r) => ({
      sessionStartsAt: new Date(r.startsAt),
      settlesBy: r.outcomeAt
        ? reportWindowClosesAt(new Date(r.outcomeAt))
        : null,
    }));
  // An unknown verdict time settles last; no pending void means the exit may run now.
  const settlesAt = (w: ExitWait) => w.settlesBy?.getTime() ?? Infinity;
  return pending.reduce<ExitWait | null>(
    (last, w) => (last === null || settlesAt(w) > settlesAt(last) ? w : last),
    null,
  );
}

/**
 * The learner's sentence, in their zone. A disputed or weak verdict waits for ops
 * past its window, so the window's close is named as such, never as a settle date.
 */
export function exitWaitMessage(
  wait: ExitWait,
  zone: string,
  now: Date,
): string {
  const clock = zoneClock(zone);
  const lead = `We're confirming what happened in your ${clock.dayMonth(wait.sessionStartsAt)} session.`;
  if (wait.settlesBy && wait.settlesBy > now) {
    return `${lead} You can leave the series once it's settled; the report window closes ${clock.dayMonth(wait.settlesBy)}, ${clock.time(wait.settlesBy)}, and if it needs a review our team will decide.`;
  }
  return `${lead} Our team is reviewing it, and you can leave the series once it's settled.`;
}
