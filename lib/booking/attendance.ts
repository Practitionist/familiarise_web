/**
 * The handoff between the two jobs that decide a past consultation: the
 * consultant no-show detector, which alone cancels and refunds a consultant who
 * never joined, and the outcome sweep in `auto-complete-appointments`. Both read
 * the same verdict (`classifySessionOutcome` over Stream's settled record), and
 * the sweep leaves a consultation host no-show to the detector until the handoff below.
 */

import type { OutageWindow } from "./session-outcome";

/**
 * How long after the last slot ends a missing consultant is still allowed to be
 * a late join or a delayed webhook rather than a no-show. Deliberately generous
 * because the detector's remedy is an automatic refund, and money is hard to
 * put back.
 */
export const NO_SHOW_GRACE_MINUTES = 120;

/**
 * When auto-complete stops waiting for the detector and completes an unattended
 * booking anyway.
 *
 * The detector declines candidates it cannot decide — Stream's record of a
 * session is not stored yet, or the run simply errored — and it leaves those
 * bookings APPROVED. Without a deadline
 * those rows would be claimed by neither job and would sit live forever, which
 * is a worse failure than completing them. Two hours past the grace window
 * gives the hourly detector at least one and normally two full runs in which
 * the booking was visible to it, so by the time this expires the detector has
 * either cancelled the booking or decided not to.
 */
export const NO_SHOW_HANDOFF_MINUTES = NO_SHOW_GRACE_MINUTES + 120;

/**
 * Has the detector had its chance at this booking?
 *
 * `true` means auto-complete may complete it even in the no-show shape, because
 * the detector has been able to see it for long enough that its silence is a
 * decision rather than a schedule. #1746 B — the detector is a financial job
 * that DEGRADED maintenance holds, so the clock pauses for every outage minute.
 */
export function isPastNoShowHandoff(
  lastSlotEndsAt: Date | null | undefined,
  now: Date = new Date(),
  outages: readonly Pick<OutageWindow, "startsAt" | "endsAt">[] = [],
): boolean {
  // A booking whose slot end we cannot read cannot be held back on a deadline
  // we cannot compute; treat it as past the handoff so it can never strand.
  if (!lastSlotEndsAt) return true;
  const from = lastSlotEndsAt.getTime();
  const to = now.getTime();
  const paused = outages.reduce((sum, w) => {
    const start = Math.max(from, w.startsAt.getTime());
    const end = Math.min(to, w.endsAt?.getTime() ?? to);
    return sum + Math.max(0, end - start);
  }, 0);
  return to - from - paused >= NO_SHOW_HANDOFF_MINUTES * 60 * 1000;
}
