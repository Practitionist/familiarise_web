import type { AppointmentsType } from "@prisma/client";

/** Returns true for 1-to-Many events (WEBINAR, CLASS) that use moderated backstage and stage controls. */
export function isOneToManyAppointmentType(
  appointmentType: AppointmentsType | string | null | undefined,
): boolean {
  return appointmentType === "WEBINAR" || appointmentType === "CLASS";
}

/** Determines whether a participant is in backstage awaiting the host's Go Live transition. */
export function isAwaitingHostGoLive(args: {
  appointmentType: AppointmentsType | string | null | undefined;
  isCallLive: boolean;
  isBackstageEnabled: boolean;
}): boolean {
  if (args.isCallLive) return false;
  return (
    args.isBackstageEnabled || isOneToManyAppointmentType(args.appointmentType)
  );
}

/** Disables in-call chat for free Trial sessions while keeping it enabled for paid offerings. */
export function isInCallChatAllowed(
  appointmentType: AppointmentsType | string | null | undefined,
): boolean {
  return appointmentType !== "TRIAL";
}

/** Builds per-call Stream settings_override for 1-to-Many (WEBINAR, CLASS) and 1:1 sessions. */
export function buildCallSettingsOverride(
  appointmentType: AppointmentsType | string,
  maxDurationSeconds: number | null,
): Record<string, unknown> | undefined {
  if (isOneToManyAppointmentType(appointmentType)) {
    return {
      ...(maxDurationSeconds !== null
        ? { limits: { max_duration_seconds: maxDurationSeconds } }
        : {}),
      session: { inactivity_timeout_seconds: 300 },
      backstage: { enabled: true, join_ahead_time_seconds: 900 },
      audio: { mic_default_on: false, access_request_enabled: true },
      video: { camera_default_on: false, access_request_enabled: true },
      screenshare: { access_request_enabled: true },
      recording: { mode: "available", layout: { name: "spotlight" } },
    };
  }
  if (maxDurationSeconds !== null) {
    return {
      limits: { max_duration_seconds: maxDurationSeconds },
    };
  }
  return undefined;
}
