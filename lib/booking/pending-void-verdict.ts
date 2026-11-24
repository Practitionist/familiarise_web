/**
 * Every class remedy that prices or refunds a void (the series exit, an
 * ordinary leave, the host's whole-class cancel, a make-up skip) waits while a
 * void it covers carries a negative verdict nobody confirmed, so no remedy pays
 * for a session that may yet be held. Pure and client-safe: this is the
 * in-memory twin of `UNCONFIRMED_NEGATIVE_VOID`, shared by the doors and the pages.
 */
import type { OccurrenceOutcome } from "@prisma/client";

import { zoneClock } from "@/lib/time/zone-clock";
import { isNegativeMoneyOutcome, reportWindowClosesAt } from "./misses";

export interface PendingVoidVerdict {
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

/** The in-memory twin of `UNCONFIRMED_NEGATIVE_VOID`; change both together. */
const isPendingVoid = (r: VoidRow) =>
  r.completionStatus === "VOIDED" &&
  !r.deletedAt &&
  !r.seatsSettledAt &&
  isNegativeMoneyOutcome(r.outcome) &&
  !r.outcomeConfirmedAt;

/** The unconfirmed negative void among `rows` that settles last, or null when the remedy may run now. */
export function pendingVoidVerdict(
  rows: readonly VoidRow[],
): PendingVoidVerdict | null {
  const pending = rows.filter(isPendingVoid).map((r) => ({
    sessionStartsAt: new Date(r.startsAt),
    settlesBy: r.outcomeAt ? reportWindowClosesAt(new Date(r.outcomeAt)) : null,
  }));
  // An unknown verdict time settles last; no pending void means the remedy may run now.
  const settlesAt = (w: PendingVoidVerdict) =>
    w.settlesBy?.getTime() ?? Infinity;
  return pending.reduce<PendingVoidVerdict | null>(
    (last, w) => (last === null || settlesAt(w) > settlesAt(last) ? w : last),
    null,
  );
}

/** The remedy that waits, in the sentence the person reads. */
export type PendingVoidAction = "leave" | "cancel" | "skip";

const WHAT_WAITS: Record<
  PendingVoidAction,
  { whose: string; open: string; passed: string }
> = {
  leave: {
    whose: "your",
    open: "You can leave the series once it's settled",
    passed: "you can leave the series once it's settled",
  },
  cancel: {
    whose: "the",
    open: "You can cancel the class once it's settled",
    passed: "you can cancel the class once it's settled",
  },
  skip: {
    whose: "your",
    open: "Its refund waits until it's settled",
    passed: "its refund waits until it's settled",
  },
};

/**
 * The sentence in the reader's zone. A disputed or weak verdict waits for ops
 * past its window, so the window's close is named as such, never as a settle date.
 */
export function pendingVerdictMessage(
  wait: PendingVoidVerdict,
  zone: string,
  now: Date,
  action: PendingVoidAction,
): string {
  const clock = zoneClock(zone);
  const copy = WHAT_WAITS[action];
  const lead = `We're confirming what happened in ${copy.whose} ${clock.dayMonth(wait.sessionStartsAt)} session.`;
  if (wait.settlesBy && wait.settlesBy > now) {
    return `${lead} ${copy.open}; the report window closes ${clock.dayMonth(wait.settlesBy)}, ${clock.time(wait.settlesBy)}, and if it needs a review our team will decide.`;
  }
  return `${lead} Our team is reviewing it, and ${copy.passed}.`;
}
