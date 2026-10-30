// How far ahead a server-placed session must start: the buyer's lead time once
// the booking is paid, more while the client still has to pay for it.

import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";

/** An unpaid approval leaves the client time to pay before the session starts. */
export const UNPAID_APPROVAL_LEAD_TIME_MS = 2 * 60 * 60_000;

/** 15 minutes for a settled booking, 2 hours for one still awaiting payment. */
export function leadTimeFor({ settled }: { settled: boolean }): number {
  return settled ? MINIMUM_BOOKING_LEAD_TIME_MS : UNPAID_APPROVAL_LEAD_TIME_MS;
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
    firstSessionStart.getTime() - now.getTime() <
    leadTimeFor({ settled: false })
  ) {
    throw tooCloseToStartError();
  }
}
