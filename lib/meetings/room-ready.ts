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

/** Stream `limits` participant fields, as sent in `settings_override`. */
export interface CallParticipantLimits {
  max_participants: number;
  max_participants_exclude_owner?: boolean;
  max_participants_exclude_roles?: string[];
}

/** Hosts, presenters and a second device sit above the sold seats of a 1-to-Many room. */
export const GROUP_CALL_HEADROOM = 5;

/** Host, a reassigned host and one client, each on two devices: every Stream session counts. */
export const PAIR_CALL_MAX_PARTICIPANTS = 6;

/** Roles that never count toward a 1-to-Many room's cap. */
const GROUP_CAP_EXEMPT_ROLES = ["co_presenter", "admin"];

/**
 * The participant cap a call is created with: sold capacity plus headroom for a 1-to-Many
 * room (call owner and presenter roles excluded), a fixed small cap for a 1:1 room.
 */
export function resolveCallParticipantLimits(
  appointmentType: AppointmentTypeInput,
  capacity: number | null,
): CallParticipantLimits | undefined {
  if (!isOneToManyAppointmentType(appointmentType)) {
    return { max_participants: PAIR_CALL_MAX_PARTICIPANTS };
  }
  if (capacity === null || !Number.isInteger(capacity) || capacity < 1) {
    return undefined;
  }
  return {
    max_participants: capacity + GROUP_CALL_HEADROOM,
    max_participants_exclude_owner: true,
    max_participants_exclude_roles: GROUP_CAP_EXEMPT_ROLES,
  };
}

/** Reads the participant cap back from a Stream call so a mirror re-sends what the call already has. */
export function participantLimitsFromStream(
  limits:
    | {
        max_participants?: number;
        max_participants_exclude_owner?: boolean;
        max_participants_exclude_roles?: string[];
      }
    | null
    | undefined,
): CallParticipantLimits | undefined {
  if (typeof limits?.max_participants !== "number") return undefined;
  return {
    max_participants: limits.max_participants,
    ...(limits.max_participants_exclude_owner !== undefined
      ? {
          max_participants_exclude_owner: limits.max_participants_exclude_owner,
        }
      : {}),
    ...(limits.max_participants_exclude_roles?.length
      ? {
          max_participants_exclude_roles: limits.max_participants_exclude_roles,
        }
      : {}),
  };
}

/** Builds per-call Stream settings_override for duration and participant limits and 1-to-Many backstage moderation. */
export function buildCallSettingsOverride(
  appointmentType: AppointmentTypeInput,
  maxDurationSeconds: number | null,
  participantLimits?: CallParticipantLimits,
): Record<string, unknown> | undefined {
  const isOneToMany = isOneToManyAppointmentType(appointmentType);
  if (!isOneToMany && maxDurationSeconds === null && !participantLimits) {
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
            speaker_default_on: true,
            default_device: "speaker",
            access_request_enabled: true,
            opus_dtx_enabled: true,
            redundant_coding_enabled: true,
          },
          video: {
            enabled: true,
            camera_default_on: false,
            camera_facing: "front",
            access_request_enabled: true,
            target_resolution: {
              width: 1280,
              height: 720,
              bitrate: 1500000,
            },
          },
        }
      : {}),
    ...(maxDurationSeconds !== null || participantLimits
      ? {
          limits: {
            ...(maxDurationSeconds !== null
              ? { max_duration_seconds: maxDurationSeconds }
              : {}),
            ...participantLimits,
          },
        }
      : {}),
  };
}
