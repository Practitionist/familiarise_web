import type {
  RequiredNoticeKind,
  RequiredOverride,
} from "@/lib/notifications/required-notices";

/**
 * The refund reasons written when someone other than the payer ended the
 * payer's booking. `Refund.reason` is the durable record of that cause, so
 * every door that announces the refund (the inline settle, the webhook,
 * reconcile) reads it back with {@link refundNoticeKind}.
 */
export type CancelSide = "consultant" | "consultee" | "staff";

export function cancelRefundReason(
  refundPct: number,
  side: CancelSide,
): string {
  return `cancellation (${refundPct}% per booking-time policy, ${side}-initiated)`;
}

/** A credit-funded 1:1 cancel restores the credit in full whatever the tier. */
export function creditCancelRefundReason(
  tierRefundPct: number,
  side: CancelSide,
): string {
  return `cancellation (credit-funded booking, credit restored in full from the ${tierRefundPct}% tier, ${side}-initiated)`;
}

/** A paid trial's cancel reason; the credit-funded form names its tier. */
export function trialCancelRefundReason(
  side: CancelSide,
  quote: { tierRefundPct: number; creditRestoresInFull: boolean },
): string {
  return quote.creditRestoresInFull
    ? `trial cancellation (credit-funded trial, credit restored in full from the ${quote.tierRefundPct}% tier, ${side}-initiated)`
    : `trial cancellation (${quote.tierRefundPct}% per booking-time policy, ${side}-initiated)`;
}

export function wholeEventCancelRefundReason(
  kind: string,
  reason: string,
  byStaff = false,
): string {
  return `whole-event ${kind} cancellation${byStaff ? " by staff" : ""} (${reason})`;
}

export function seatRemovalRefundReason(
  kind: "class" | "webinar",
  eventId: string,
  organiserInitiated: boolean,
  refundPct: number,
): string {
  return `removed from ${kind} ${eventId} by the ${organiserInitiated ? "organiser" : "attendee"} (${refundPct}%)`;
}

export function rejectionRefundReason(kind: string, refundPct: number): string {
  return `${kind} request rejected by consultant (${refundPct}%)`;
}

/** The refund reasons of the staff doors that end bookings: moderation and a maintenance freeze. */
export const STAFF_CANCEL_REFUND_REASON = {
  MODERATION: "moderation (100% — platform-initiated cancellation)",
  MAINTENANCE: "Scheduled platform maintenance",
} as const;

/** The class sweep's refund reasons; the host-caused ones are required. */
export const CLASS_SESSION_REFUND_REASON = {
  HOST_CANCELLED: "HOST_SESSION_NOT_MADE_UP",
  HOST_VOIDED: "HOST_SESSION_VOIDED_NOT_MADE_UP",
  VOIDED: "SESSION_VOIDED_NOT_MADE_UP",
} as const;

const SEAT_REMOVED_BY_ORGANISER =
  /^removed from (class|webinar) \S+ by the organiser /;
const REQUEST_REJECTED = / request rejected by consultant \(\d+(\.\d+)?%\)$/;

/** The required notice kind a refund with this reason announces, or null when it stays optional. */
export function refundNoticeKind(
  reason: string | null | undefined,
): RequiredNoticeKind | null {
  if (!reason) return null;
  if (
    reason.startsWith("cancellation (") ||
    reason.startsWith("trial cancellation (")
  ) {
    if (reason.endsWith(", consultant-initiated)")) {
      return "REFUND_FROM_HOST_CANCEL";
    }
    if (reason.endsWith(", staff-initiated)")) {
      return "REFUND_FROM_STAFF_CANCEL";
    }
    return null;
  }
  if (reason.startsWith("whole-event ")) {
    return / cancellation by staff \(/.test(reason)
      ? "REFUND_FROM_STAFF_CANCEL"
      : "REFUND_FROM_HOST_CANCEL";
  }
  if (
    reason === STAFF_CANCEL_REFUND_REASON.MODERATION ||
    reason === STAFF_CANCEL_REFUND_REASON.MAINTENANCE
  ) {
    return "REFUND_FROM_STAFF_CANCEL";
  }
  if (SEAT_REMOVED_BY_ORGANISER.test(reason)) return "SEAT_RELEASED";
  if (REQUEST_REJECTED.test(reason)) return "REQUEST_DECLINED";
  if (
    reason === CLASS_SESSION_REFUND_REASON.HOST_CANCELLED ||
    reason === CLASS_SESSION_REFUND_REASON.HOST_VOIDED
  ) {
    return "CLASS_SESSION_REFUNDED";
  }
  return null;
}

/**
 * The reason a refund's notice is classified by: a hand refund that settles an
 * owed refund announces that refund's cause; any other refund, its own reason.
 */
export function noticeReason(
  settledOwed: { reason: string } | null | undefined,
  reason: string | null | undefined,
): string | null | undefined {
  return settledOwed && refundNoticeKind(settledOwed.reason) !== null
    ? settledOwed.reason
    : reason;
}

/** The bell override for the payer of a refund with this reason. */
export function refundNoticeOverride(
  reason: string | null | undefined,
  payerUserId: string,
): RequiredOverride | undefined {
  const kind = refundNoticeKind(reason);
  return kind ? { kind, recipients: [payerUserId] } : undefined;
}
