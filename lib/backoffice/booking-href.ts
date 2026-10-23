import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/** Where a booking opens in the console: the Appointments page, opened on it. */
export const bookingHref = (basePath: string, appointmentId: string) =>
  `${basePath}/appointments?open=${encodeURIComponent(appointmentId)}`;

/**
 * The booking's back-office Ops panel for an ADMIN or STAFF who is not a party
 * to it, whom the participant reschedule and cancel routes refuse; null for
 * anyone else.
 */
export function operatorOpsHref(
  viewer: { role?: string | null } | null | undefined,
  isParty: boolean,
  appointmentId: string,
): string | null {
  if (isParty || !isOperatorRole(viewer?.role)) return null;
  const tree = viewer?.role === "ADMIN" ? "admin" : "staff";
  return bookingHref(`/dashboard/${tree}`, appointmentId);
}
