/**
 * Status guards for the appointment/event status union. Moved here from the
 * consultee appointments feature (utils/status-guards.ts, which re-exports
 * this module) so the shared appointments VM layer can bucket without
 * importing from a dashboard route.
 *
 * The event union carries statuses from three enums (AppointmentStatus,
 * TrialStatus, Webinar/ClassStatus) plus legacy lowercase values,
 * so guards normalize case rather than typing against one enum.
 */

const TERMINAL_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "COMPLETED",
  "EXPIRED",
  // TrialStatus terminal: the consultee subscribed after the trial —
  // nothing further can happen on the trial booking itself.
  "CONVERTED",
]);

/** Terminal AND negative — the booking never (fully) happened. */
const CANCELLED_LIKE_STATUSES = new Set(["CANCELLED", "REJECTED", "EXPIRED"]);

/** Terminal AND positive — the booking ran its course. */
const COMPLETED_LIKE_STATUSES = new Set(["COMPLETED", "CONVERTED"]);

// "APPROVED" appears here AND in isApprovedStatus deliberately: approved is
// both a locked-in state (uploads/joining enabled — isConfirmedStatus) and a
// distinct pre-scheduling phase some surfaces branch on (isApprovedStatus is
// a strict subset check of isConfirmedStatus).
const CONFIRMED_STATUSES = new Set(["APPROVED", "SCHEDULED"]);

export const normalizeStatus = (status: string | null | undefined): string =>
  status?.toUpperCase() ?? "";

/** Terminal states — no further user action is possible on the booking. */
export function isInactiveStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

/** Terminal-negative: cancelled / rejected / expired. */
export function isCancelledLikeStatus(
  status: string | null | undefined,
): boolean {
  return CANCELLED_LIKE_STATUSES.has(normalizeStatus(status));
}

/** Terminal-positive: completed / converted. */
export function isCompletedLikeStatus(
  status: string | null | undefined,
): boolean {
  return COMPLETED_LIKE_STATUSES.has(normalizeStatus(status));
}

/** Consultant approved; payment is the blocking step. Cancellable (no charge yet). */
export function isPendingPaymentStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeStatus(status);
  // AWAITING_PAYMENT is the trial equivalent of APPROVED_PENDING_PAYMENT:
  // accepted by the provider, slot held, money not yet collected. Both must
  // bucket as PAY_NOW or the learner never sees the "Pay Now to Confirm"
  // affordance on the booking itself.
  return (
    normalized === "APPROVED_PENDING_PAYMENT" ||
    normalized === "AWAITING_PAYMENT"
  );
}

export function isPendingStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status) === "PENDING";
}

export function isApprovedStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status) === "APPROVED";
}

/** Booking is locked in (approved/scheduled/live) — enables uploads, joining, etc. */
export function isConfirmedStatus(status: string | null | undefined): boolean {
  return CONFIRMED_STATUSES.has(normalizeStatus(status));
}

/** A seat still held on a payment that never succeeded: not registered, no Join. */
export function isUnpaidSeat(vm: {
  seatStatus?: string | null;
  paid?: boolean;
}): boolean {
  return normalizeStatus(vm.seatStatus) === "HELD" && vm.paid !== true;
}

/** The viewer's own seat was given back: they left, were removed, or the event was cancelled. */
export function isReleasedSeat(seatStatus: string | null | undefined): boolean {
  const s = normalizeStatus(seatStatus);
  return s === "CANCELLED" || s === "REFUNDED";
}

/** The viewer's own seat status on a webinar or class read scoped to their participant row. */
export function ownSeatStatusOf(
  appointment:
    | { id: string; participants?: ReadonlyArray<{ status: string }> }
    | null
    | undefined,
): string | null {
  return appointment?.participants?.[0]?.status ?? null;
}

/** The viewer's seat no longer holds a place: given back, or held on a payment whose window closed. */
export function seatLapsedOrReleased(
  vm: {
    seatStatus?: string | null;
    paid?: boolean;
    payDeadline?: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (isReleasedSeat(vm.seatStatus)) return true;
  return (
    isUnpaidSeat(vm) &&
    !(vm.payDeadline && vm.payDeadline.getTime() > now.getTime())
  );
}
