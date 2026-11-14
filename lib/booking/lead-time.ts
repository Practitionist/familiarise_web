// The one lead-time contract: how far ahead a session must start, per purpose.
// The grid, checkout, request-for-approval, the allocator and reschedule all
// read it, so a cell the grid paints free is never refused for being too soon.

import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";

/** An unpaid approval leaves the client time to pay before the session starts. */
export const UNPAID_APPROVAL_LEAD_TIME_MS = 2 * 60 * 60_000;

/**
 * Short notice: a 1:1 move from or to a time closer than this needs the other
 * side's acceptance; a webinar, a trial or an operator's move is refused.
 */
export const RESCHEDULE_MIN_LEAD_HOURS = 24;

export const RESCHEDULE_LEAD_TIME_MS = RESCHEDULE_MIN_LEAD_HOURS * 60 * 60_000;

export const LEAD_PURPOSES = [
  "book",
  "request",
  "allocate",
  "reschedule",
] as const;
export type LeadPurpose = (typeof LEAD_PURPOSES)[number];

/**
 * book: an instant checkout (15 min). request / allocate: 15 min once the
 * booking is settled (paid or free), 2 h while the client still has to pay.
 * reschedule: 24 h, the notice a move confirmed by one side alone needs.
 */
export function leadMsFor(
  purpose: LeadPurpose,
  { settled }: { settled: boolean } = { settled: true },
): number {
  switch (purpose) {
    case "book":
      return MINIMUM_BOOKING_LEAD_TIME_MS;
    case "request":
    case "allocate":
      return settled
        ? MINIMUM_BOOKING_LEAD_TIME_MS
        : UNPAID_APPROVAL_LEAD_TIME_MS;
    case "reschedule":
      return RESCHEDULE_LEAD_TIME_MS;
  }
}

/**
 * The lead a buyer's pick on an expert page needs: a REQUEST-mode plan is paid
 * only after approval, so a priced one uses the request lead.
 */
export function leadMsForPlan(
  requestMode: boolean,
  price: number | string | null | undefined,
): number {
  return leadMsFor(requestMode ? "request" : "book", {
    settled: Number(price ?? 0) <= 0,
  });
}

/** "15 minutes" / "2 hours" / "24 hours": a lead time in words. */
export function leadLabel(leadMs: number): string {
  const minutes = Math.round(leadMs / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/**
 * The one boundary: a start at or before now + the purpose's lead is too
 * soon. Every writer and every grid compares through this.
 */
export function isTooSoonFor(
  purpose: LeadPurpose,
  ctx: { settled: boolean },
  startMs: number,
  nowMs: number,
): boolean {
  return startMs <= nowMs + leadMsFor(purpose, ctx);
}

/** The refusal for approving an unpaid request whose session starts too soon to pay for. */
export function tooCloseToStartError(): BookingRuleError {
  return new BookingRuleError(
    "TOO_CLOSE_TO_START",
    "This session starts too soon for the client to pay first. Propose a later time instead.",
  );
}

/**
 * An unpaid approval needs its first session at least the unpaid lead time
 * away; checked inside the approving transaction, before the status write.
 * A request with no placed session yet has nothing to check.
 */
export function assertUnpaidApprovalFits(
  firstSessionStart: Date | null | undefined,
  now: Date = new Date(),
): void {
  if (!firstSessionStart) return;
  if (
    isTooSoonFor(
      "allocate",
      { settled: false },
      firstSessionStart.getTime(),
      now.getTime(),
    )
  ) {
    throw tooCloseToStartError();
  }
}

/**
 * A priced request is paid only after the expert approves it, so its time must
 * leave room for both; refused up front rather than held until it lapses.
 */
export function assertRequestLeadFits(
  pricePaise: number | bigint,
  startsAt: Date,
  now: Date = new Date(),
): void {
  const settled = Number(pricePaise) <= 0;
  if (isTooSoonFor("request", { settled }, startsAt.getTime(), now.getTime())) {
    throw new BookingRuleError(
      "REQUEST_TOO_SOON",
      `Your expert needs time to accept and you need time to pay — pick a time at least ${leadLabel(leadMsFor("request", { settled }))} away.`,
    );
  }
}

/** A start less than 24 hours away: a 1:1 move to or from it needs the other side's acceptance. */
export function isShortNotice(startMs: number, nowMs: number): boolean {
  return isTooSoonFor("reschedule", { settled: true }, startMs, nowMs);
}
