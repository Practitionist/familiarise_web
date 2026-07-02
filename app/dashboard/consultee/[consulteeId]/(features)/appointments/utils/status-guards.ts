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

import {
  APPOINTMENT_STATUS_BADGE,
  EVENT_STATUS_BADGE,
  TRIAL_STATUS_BADGE,
  formatStatusLabel,
  type StatusBadgeStyle,
} from "@/lib/labels/session-labels";

const TERMINAL_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "COMPLETED",
  "EXPIRED",
]);

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

/**
 * Badge style for the consultee event UNION (consultations/subscriptions
 * carry AppointmentStatus, webinars/classes carry Webinar/ClassStatus,
 * trials carry TrialSessionStatus). Tries the maps in specificity order
 * and falls back to a neutral title-cased pill for legacy values.
 */
export function eventUnionStatusBadge(
  status: string | null | undefined,
): StatusBadgeStyle {
  const s = normalize(status);
  if (s in APPOINTMENT_STATUS_BADGE) {
    return APPOINTMENT_STATUS_BADGE[s as keyof typeof APPOINTMENT_STATUS_BADGE];
  }
  if (s in EVENT_STATUS_BADGE) {
    return EVENT_STATUS_BADGE[s as keyof typeof EVENT_STATUS_BADGE];
  }
  if (s in TRIAL_STATUS_BADGE) {
    return TRIAL_STATUS_BADGE[s as keyof typeof TRIAL_STATUS_BADGE];
  }
  return {
    label: status ? formatStatusLabel(status) : "Unknown",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  };
}
