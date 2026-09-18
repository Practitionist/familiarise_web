/**
 * #1703 B12 — the consultant Appointments list's default read window. Kept
 * out of lib/data so the client page can import the constant without
 * pulling prisma into the browser bundle.
 */

export type ConsultantAppointmentsWindow = "recent" | "all";

export const CONSULTANT_APPOINTMENTS_WINDOW_MONTHS = 12;

/** Start of the recent window: 12 months before the start of today. */
export function recentWindowStart(now: Date = new Date()): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth() - CONSULTANT_APPOINTMENTS_WINDOW_MONTHS,
    now.getDate(),
  );
}
