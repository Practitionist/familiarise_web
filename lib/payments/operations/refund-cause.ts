import type {
  RequiredNoticeKind,
  RequiredOverride,
} from "@/lib/notifications/required-notices";

/**
 * The refund reasons written when the host side ended the payer's booking.
 * `Refund.reason` is the durable record of that cause, so every door that
 * announces the refund (the inline settle, the webhook, reconcile) reads it.
 */
export function cancelRefundReason(
  refundPct: number,
  hostSide: boolean,
): string {
  return `cancellation (${refundPct}% per booking-time policy, ${hostSide ? "consultant" : "consultee"}-initiated)`;
}

export function wholeEventCancelRefundReason(
  kind: string,
  reason: string,
): string {
  return `whole-event ${kind} cancellation (${reason})`;
}

export function seatRemovalRefundReason(
  kind: "class" | "webinar",
  eventId: string,
  organiserInitiated: boolean,
  refundPct: number,
): string {
  return `removed from ${kind} ${eventId} by the ${organiserInitiated ? "organiser" : "attendee"} (${refundPct}%)`;
}

const SEAT_REMOVED_BY_ORGANISER = /^removed from (class|webinar) \S+ by the organiser /;

/** The required notice kind a refund with this reason announces, or null when it stays optional. */
export function refundNoticeKind(
  reason: string | null | undefined,
): RequiredNoticeKind | null {
  if (!reason) return null;
  if (
    reason.startsWith("cancellation (") &&
    reason.endsWith(", consultant-initiated)")
  ) {
    return "REFUND_FROM_HOST_CANCEL";
  }
  if (reason.startsWith("whole-event ")) return "REFUND_FROM_HOST_CANCEL";
  if (SEAT_REMOVED_BY_ORGANISER.test(reason)) return "SEAT_RELEASED";
  return null;
}

/** The bell override for the payer of a refund with this reason. */
export function refundNoticeOverride(
  reason: string | null | undefined,
  payerUserId: string,
): RequiredOverride | undefined {
  const kind = refundNoticeKind(reason);
  return kind ? { kind, recipients: [payerUserId] } : undefined;
}
