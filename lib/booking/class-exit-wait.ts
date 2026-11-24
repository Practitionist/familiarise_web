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
  /** When its report window closes, after which the pass or ops settle it; null when its verdict time is unknown. */
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
  if (pending.length === 0) return null;
  return pending.reduce((last, w) =>
    (w.settlesBy?.getTime() ?? Infinity) >
    (last.settlesBy?.getTime() ?? Infinity)
      ? w
      : last,
  );
}

/** The learner's sentence, in their zone: "…your 12 Nov session; … (by 14 Nov, 5:15 pm IST)". */
export function exitWaitMessage(wait: ExitWait, zone: string): string {
  const clock = zoneClock(zone);
  const by = wait.settlesBy
    ? ` (by ${clock.dayMonth(wait.settlesBy)}, ${clock.time(wait.settlesBy)})`
    : "";
  return `We're confirming what happened in your ${clock.dayMonth(wait.sessionStartsAt)} session; you can leave the series once that's settled${by}.`;
}
