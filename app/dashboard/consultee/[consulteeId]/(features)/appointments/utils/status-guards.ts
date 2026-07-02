/**
 * Single source of truth for the consultee-side booking status guards.
 * Previously reimplemented (with subtle casing differences) in
 * OneOffEventCard, MultiSessionEventCard, and HomeTab's
 * UpcomingSessionCard.
 *
 * The event union carries statuses from three enums (AppointmentStatus,
 * TrialSessionStatus, Webinar/ClassStatus) plus legacy lowercase values,
 * so guards normalize case rather than typing against one enum.
 */

const TERMINAL_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "COMPLETED",
  "EXPIRED",
  // TrialSessionStatus terminal: the consultee subscribed after the trial —
  // nothing further can happen on the trial booking itself.
  "CONVERTED",
]);

// "APPROVED" appears here AND in isApprovedStatus deliberately: approved is
// both a locked-in state (uploads/joining enabled — isConfirmedStatus) and a
// distinct pre-scheduling phase some surfaces branch on (isApprovedStatus is
// a strict subset check of isConfirmedStatus).
const CONFIRMED_STATUSES = new Set(["APPROVED", "SCHEDULED", "IN_PROGRESS"]);

const normalize = (status: string | null | undefined) =>
  status?.toUpperCase() ?? "";

/** Terminal states — no further user action is possible on the booking. */
export function isInactiveStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(normalize(status));
}

/** Consultant approved; payment is the blocking step. Cancellable (no charge yet). */
export function isPendingPaymentStatus(
  status: string | null | undefined,
): boolean {
  return normalize(status) === "APPROVED_PENDING_PAYMENT";
}

export function isApprovedStatus(status: string | null | undefined): boolean {
  return normalize(status) === "APPROVED";
}

/** Booking is locked in (approved/scheduled/live) — enables uploads, joining, etc. */
export function isConfirmedStatus(status: string | null | undefined): boolean {
  return CONFIRMED_STATUSES.has(normalize(status));
}
