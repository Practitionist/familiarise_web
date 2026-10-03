import type { AppointmentsType } from "@prisma/client";

export type AppointmentTypeInput = AppointmentsType | string | null | undefined;

/** Returns true for 1-to-Many events (WEBINAR, CLASS) that use moderated backstage and stage controls. */
export function isOneToManyAppointmentType(
  appointmentType: AppointmentTypeInput,
): boolean {
  return appointmentType === "WEBINAR" || appointmentType === "CLASS";
}

/** Determines whether a participant is in backstage awaiting the host's Go Live transition. */
export function isAwaitingHostGoLive(args: {
  appointmentType: AppointmentTypeInput;
  isCallLive: boolean;
  isBackstageEnabled: boolean;
}): boolean {
  if (args.isCallLive || !args.isBackstageEnabled) return false;
  return isOneToManyAppointmentType(args.appointmentType);
}

/** Disables in-call chat for free Trial sessions while keeping it enabled for paid offerings. */
export function isInCallChatAllowed(
  appointmentType: AppointmentTypeInput,
): boolean {
  return appointmentType !== "TRIAL";
}

/** Builds per-call Stream settings_override for session duration limits. */
export function buildCallSettingsOverride(
  _appointmentType: AppointmentsType | string,
  maxDurationSeconds: number | null,
): Record<string, unknown> | undefined {
  if (maxDurationSeconds !== null) {
    return {
      limits: { max_duration_seconds: maxDurationSeconds },
    };
  }
  return undefined;
}
