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

/** Builds per-call Stream settings_override for session duration limits and 1-to-Many backstage moderation. */
export function buildCallSettingsOverride(
  appointmentType: AppointmentTypeInput,
  maxDurationSeconds: number | null,
): Record<string, unknown> | undefined {
  const isOneToMany = isOneToManyAppointmentType(appointmentType);
  if (!isOneToMany && maxDurationSeconds === null) {
    return undefined;
  }

  return {
    ...(isOneToMany
      ? {
          backstage: {
            enabled: true,
            join_ahead_time_seconds: 900,
          },
          audio: {
            mic_default_on: false,
            default_device: "speaker",
            access_request_enabled: true,
          },
          video: {
            camera_default_on: false,
            access_request_enabled: true,
          },
        }
      : {}),
    ...(maxDurationSeconds !== null
      ? { limits: { max_duration_seconds: maxDurationSeconds } }
      : {}),
  };
}
