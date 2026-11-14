/**
 * When the expert's "You're in demand" banner shows. The thresholds are
 * judgement defaults, named here and changed only in code.
 */

import type { ExpertDemand } from "@/schemas/expert-demand";

/** How far ahead the booked share looks. */
export const DEMAND_HORIZON_DAYS = 14;
/** Open requests at this share of the expert's cap… */
export const OPEN_REQUESTS_CAP_SHARE = 0.75;
/** …or this many when no cap is set. */
export const OPEN_REQUESTS_WITHOUT_CAP = 5;
/** A request lapsing within this many hours. */
export const REQUEST_EXPIRY_SOON_HOURS = 12;
/** A paid plan unplaced for longer than this. */
export const PLAN_UNPLACED_HOURS = 24;
/** The next fortnight's published time at least this booked. */
export const BOOKED_SHARE_HIGH = 0.8;
/** How long "Dismiss" hides the banner unless a new kind of signal fires. */
export const DEMAND_DISMISS_DAYS = 7;

export type DemandSignal =
  | "OPEN_REQUESTS"
  | "REQUEST_EXPIRING"
  | "PLANS_UNPLACED"
  | "WEEKS_FULL"
  | "LEARNERS_WAITING";

const HOUR_MS = 3_600_000;

/** The signals that fire for this read; none for a paused expert, who sees the paused notice. */
export function demandSignals(d: ExpertDemand, now: Date): DemandSignal[] {
  if (!d.acceptingRequests) return [];
  const fired: DemandSignal[] = [];
  const openLimit =
    d.maxOpenRequests === null
      ? OPEN_REQUESTS_WITHOUT_CAP
      : d.maxOpenRequests * OPEN_REQUESTS_CAP_SHARE;
  if (d.openRequests > 0 && d.openRequests >= openLimit) {
    fired.push("OPEN_REQUESTS");
  }
  const expiry = d.nearestRequestExpiry
    ? Date.parse(d.nearestRequestExpiry)
    : NaN;
  if (expiry - now.getTime() <= REQUEST_EXPIRY_SOON_HOURS * HOUR_MS) {
    fired.push("REQUEST_EXPIRING");
  }
  const paidAt = d.oldestUnplacedPaidAt
    ? Date.parse(d.oldestUnplacedPaidAt)
    : NaN;
  if (now.getTime() - paidAt > PLAN_UNPLACED_HOURS * HOUR_MS) {
    fired.push("PLANS_UNPLACED");
  }
  if (d.bookedShare !== null && d.bookedShare >= BOOKED_SHARE_HIGH) {
    fired.push("WEEKS_FULL");
  }
  if (d.learnersWaiting > 0) fired.push("LEARNERS_WAITING");
  return fired;
}

/** Whether a dismissal still hides these signals: within its days, and no new kind since. */
export function dismissalHolds(
  dismissed: { at: number; signals: readonly DemandSignal[] } | null,
  signals: readonly DemandSignal[],
  now: Date,
): boolean {
  if (!dismissed) return false;
  if (now.getTime() - dismissed.at > DEMAND_DISMISS_DAYS * 24 * HOUR_MS) {
    return false;
  }
  return signals.every((s) => dismissed.signals.includes(s));
}
