/**
 * The clocks a dispute runs on.
 *
 * Three of them, and they are NOT the same clock:
 *
 *  1. The COMPLAINT clock — CP (E-Commerce) Rules 2020 r.4(4)–(5): the
 *     grievance officer must acknowledge a consumer complaint within 48 hours
 *     and redress it within one month. It runs from the claim.
 *
 *  2. The RESPONDENT clock — our own contractual promise that the expert
 *     answers within three business days. It runs from the claim, and when it
 *     expires the sweep escalates the dispute to the platform. It is the only
 *     clock the respondent controls.
 *
 *  3. The CONSUMER-DISPUTE clock — Consumer Protection Act 2019 s.2(8): a
 *     "consumer dispute" only exists once the seller DENIES the complaint.
 *     So this clock starts when the respondent REJECTS, not when the claim is
 *     filed, and the platform's own redressal duty is measured from there.
 *
 * Business days are IST, because both the respondent and the platform operate
 * on IST and a deadline that lands on a Sunday is not a deadline anybody can
 * meet.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** IST offset. The platform's operating day is IST. */
const IST_OFFSET_MS = 330 * 60_000;

/** The respondent's contractual answer window. */
export const RESPONDENT_RESPONSE_DAYS = 3;

/** The CP (E-Commerce) Rules acknowledgement window. */
export const COMPLAINT_ACK_HOURS = 48;

/** The CP (E-Commerce) Rules redressal window, in days. */
export const COMPLAINT_REDRESSAL_DAYS = 30;

/** The respondent's deadline: three business days after the claim. */
export function respondentDueAt(from: Date = new Date()): Date {
  return addBusinessDays(from, RESPONDENT_RESPONSE_DAYS);
}

/**
 * Add `days` business days to `from`, skipping Saturday and Sunday in IST.
 * The current hour is preserved, so a claim filed at 18:00 IST is due at
 * 18:00 IST three business days later — the respondent is not helped by the
 * deadline landing at 03:00.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const ist = new Date(from.getTime() + IST_OFFSET_MS);
  const dayOfWeek = ist.getUTCDay(); // 0 = Sunday
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setTime(result.getTime() + DAY_MS);
    const next = new Date(result.getTime() + IST_OFFSET_MS).getUTCDay();
    if (next !== 0 && next !== 6) remaining -= 1;
  }
  return result;
}

/** The complaint's statutory acknowledgement and redressal deadlines. */
export function complaintDeadlines(
  from: Date = new Date(),
): { ackDueAt: Date; redressalDueAt: Date } {
  return {
    ackDueAt: new Date(from.getTime() + COMPLAINT_ACK_HOURS * HOUR_MS),
    redressalDueAt: new Date(from.getTime() + COMPLAINT_REDRESSAL_DAYS * DAY_MS),
  };
}

/**
 * The consumer-dispute clock, which starts when the respondent DENIES the
 * claim (CP Act s.2(8)). A respondent who accepts the claim never starts it:
 * there is no dispute, only a refund.
 */
export function consumerDisputeDeadlines(
  deniedAt: Date = new Date(),
): { ackDueAt: Date; redressalDueAt: Date } {
  return complaintDeadlines(deniedAt);
}

/** Whether the respondent's answer window has passed. */
export function respondentWindowPassed(
  dueAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!dueAt) return false;
  return dueAt.getTime() <= now.getTime();
}

/** Whether a deadline is within `hours` — the "at risk" band on a queue. */
export function isDueWithin(
  dueAt: Date | null | undefined,
  hours: number,
  now: Date = new Date(),
): boolean {
  if (!dueAt) return false;
  const remaining = dueAt.getTime() - now.getTime();
  return remaining > 0 && remaining <= hours * HOUR_MS;
}
