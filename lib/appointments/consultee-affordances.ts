/**
 * #1005 — which consultee overflow actions are honest for each appointment kind.
 *
 * Server routes already 403 impossible actions; the UI must not offer them.
 */

import type { AppointmentKind } from "@/lib/appointments/view-model";

export type ConsulteeDestructiveAction =
  | "cancel-booking"
  | "cancel-trial"
  | "leave-event"
  | "none";

/** Reschedule is 1:1 only — group events are organiser-managed; trials have no path. */
export function consulteeMayReschedule(kind: AppointmentKind): boolean {
  return kind === "CONSULTATION" || kind === "SUBSCRIPTION";
}

/** What destructive action the overflow menu should offer. */
export function consulteeDestructiveAction(
  kind: AppointmentKind,
): ConsulteeDestructiveAction {
  switch (kind) {
    case "CONSULTATION":
    case "SUBSCRIPTION":
      return "cancel-booking";
    case "TRIAL":
      return "cancel-trial";
    case "WEBINAR":
    case "CLASS":
      return "leave-event";
    default:
      return "none";
  }
}
