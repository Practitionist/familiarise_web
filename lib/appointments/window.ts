/**
 * The consultant Appointments list's read windows. Kept out of lib/data so
 * the client page can import them without pulling prisma into the bundle.
 *
 * "recent" is every live row (a session still to end, or none placed yet),
 * capped, plus the first page of past rows. "older" pages the rest of the past
 * rows, newest-created first, through one `(createdAt, id)` keyset, so the
 * pages never repeat or skip a row.
 */

export const CONSULTANT_APPOINTMENTS_WINDOWS = ["recent", "older"] as const;
export type ConsultantAppointmentsWindow =
  (typeof CONSULTANT_APPOINTMENTS_WINDOWS)[number];

/** Live rows the recent read holds; past it the page says so. */
export const CONSULTANT_APPOINTMENTS_RECENT_CAP = 500;
/** Past rows the recent read holds: the first page of the past keyset. */
export const CONSULTANT_APPOINTMENTS_RECENT_PAST = 500;
/** Past rows one "Load older" page reads. */
export const CONSULTANT_APPOINTMENTS_PAGE = 100;

export interface AppointmentsCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_PATTERN = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;

/** `<epoch ms>.<id>` of the last row on a page. */
export function encodeAppointmentsCursor(row: {
  createdAt: Date | string;
  id: string;
}): string {
  return `${new Date(row.createdAt).getTime()}.${row.id}`;
}

/** Null for anything that is not a cursor this module wrote. */
export function decodeAppointmentsCursor(
  raw: string | null | undefined,
): AppointmentsCursor | null {
  const match = raw ? CURSOR_PATTERN.exec(raw) : null;
  if (!match) return null;
  return { createdAt: new Date(Number(match[1])), id: match[2] };
}
