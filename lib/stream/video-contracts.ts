/**
 * Stream Video API runtime contract definitions and validators.
 *
 * Enforces the server-side enum invariants required by Stream's REST API and the
 * `default` call type configuration:
 * 1. `UpdateUserPermissionsRequest` (`grant_permissions` / `revoke_permissions`)
 *    only accepts valid lower-kebab `OwnCapability` strings (and for stage/media
 *    publishing specifically `send-audio`, `send-video`, `screenshare`).
 *    Passing mixed-case strings like `"send-Audio"` causes Stream to reject the
 *    entire request with HTTP 400 (`Invalid permissions in grant_permissions`).
 * 2. `UpdateCallMembersRequest` / `getOrCreate` `members` only accepts roles that
 *    exist on the `default` call type (`call_member`, `co_presenter`, `admin`, `user`, `guest`).
 *    `"host"` is not a Stream role on `default`.
 * 3. Server-initiated `call.getOrCreate` must always include a non-empty
 *    `data.created_by_id`.
 */

export const STREAM_PUBLISH_PERMISSIONS = [
  "send-audio",
  "send-video",
  "screenshare",
] as const;

export type StreamPublishPermission =
  (typeof STREAM_PUBLISH_PERMISSIONS)[number];

const PUBLISH_PERMISSION_SET = new Set<string>(STREAM_PUBLISH_PERMISSIONS);

export const STREAM_CALL_MEMBER_ROLES = [
  "call_member",
  "co_presenter",
  "admin",
  "user",
  "guest",
] as const;

export type StreamCallMemberRole = (typeof STREAM_CALL_MEMBER_ROLES)[number];

const CALL_MEMBER_ROLE_SET = new Set<string>(STREAM_CALL_MEMBER_ROLES);

export const STREAM_OWN_CAPABILITIES = [
  "block-users",
  "cast-poll-vote",
  "change-max-duration",
  "connect-events",
  "create-call",
  "create-poll",
  "create-reaction",
  "delete-call",
  "delete-reaction",
  "enable-noise-cancellation",
  "end-call",
  "frame-record-call",
  "join-backstage",
  "join-call",
  "join-ended-call",
  "kick-user",
  "leave-call",
  "mute-users",
  "pin-call-track",
  "pin-for-everyone",
  "priority-speaker",
  "query-poll-votes",
  "read-call",
  "read-call-member",
  "remove-call-member",
  "request-permissions",
  "screenshare",
  "send-audio",
  "send-call-event",
  "send-closed-captions-call",
  "send-custom-event",
  "send-links-chat",
  "send-message-chat",
  "send-video",
  "silence-other-participants",
  "start-broadcast-call",
  "start-closed-captions-call",
  "start-frame-record-call",
  "start-individual-record-call",
  "start-raw-record-call",
  "start-record-call",
  "start-rtmp-broadcasts",
  "start-transcription-call",
  "stop-broadcast-call",
  "stop-closed-captions-call",
  "stop-frame-record-call",
  "stop-individual-record-call",
  "stop-raw-record-call",
  "stop-record-call",
  "stop-rtmp-broadcasts",
  "stop-transcription-call",
  "update-call",
  "update-call-member",
  "update-call-permissions",
  "update-call-settings",
  "update-record-call",
  "update-stats-report-interval",
  "update-thread",
  "use-virtual-background",
] as const;

export type StreamOwnCapability = (typeof STREAM_OWN_CAPABILITIES)[number];

const OWN_CAPABILITY_SET = new Set<string>(STREAM_OWN_CAPABILITIES);

export class StreamContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamContractError";
  }
}

export function isStreamPublishPermission(
  value: string,
): value is StreamPublishPermission {
  return PUBLISH_PERMISSION_SET.has(value);
}

export function filterStreamPublishPermissions(
  permissions: readonly string[],
): StreamPublishPermission[] {
  return permissions.filter(isStreamPublishPermission);
}

export function assertValidUpdateUserPermissions(request: unknown): void {
  const req = request as
    | {
        user_id?: unknown;
        grant_permissions?: unknown;
        revoke_permissions?: unknown;
      }
    | null
    | undefined;

  if (typeof req?.user_id !== "string" || !req.user_id.trim()) {
    throw new StreamContractError(
      "UpdateUserPermissions requires a non-empty user_id",
    );
  }

  const grants = Array.isArray(req.grant_permissions)
    ? req.grant_permissions
    : [];
  for (const perm of grants) {
    if (typeof perm !== "string" || !OWN_CAPABILITY_SET.has(perm)) {
      throw new StreamContractError(
        `Invalid grant_permissions capability "${String(perm)}"`,
      );
    }
  }

  const revokes = Array.isArray(req.revoke_permissions)
    ? req.revoke_permissions
    : [];
  for (const perm of revokes) {
    if (typeof perm !== "string" || !OWN_CAPABILITY_SET.has(perm)) {
      throw new StreamContractError(
        `Invalid revoke_permissions capability "${String(perm)}"`,
      );
    }
  }
}

export function assertValidUpdateCallMembers(request: unknown): void {
  const req = request as
    | {
        update_members?: ReadonlyArray<{ user_id?: unknown; role?: unknown }>;
        remove_members?: readonly unknown[];
      }
    | null
    | undefined;

  for (const member of req?.update_members ?? []) {
    if (typeof member?.user_id !== "string" || !member.user_id.trim()) {
      throw new StreamContractError(
        'UpdateCallMembers failed with error: "member user_id is required"',
      );
    }
    if (
      member.role !== undefined &&
      (typeof member.role !== "string" || !CALL_MEMBER_ROLE_SET.has(member.role))
    ) {
      throw new StreamContractError(
        `Invalid Stream call member role "${String(member.role)}". Allowed on default call type: ${STREAM_CALL_MEMBER_ROLES.join(", ")}`,
      );
    }
  }
}

export const STREAM_CAMERA_FACING_VALUES = [
  "front",
  "back",
  "external",
] as const;

export type StreamCameraFacing = (typeof STREAM_CAMERA_FACING_VALUES)[number];

const CAMERA_FACING_SET = new Set<string>(STREAM_CAMERA_FACING_VALUES);

export const STREAM_AUDIO_DEFAULT_DEVICES = ["speaker", "earpiece"] as const;

export type StreamAudioDefaultDevice =
  (typeof STREAM_AUDIO_DEFAULT_DEVICES)[number];

const AUDIO_DEFAULT_DEVICE_SET = new Set<string>(STREAM_AUDIO_DEFAULT_DEVICES);

type AudioSettingsOverrideInput = {
  mic_default_on?: unknown;
  speaker_default_on?: unknown;
  default_device?: unknown;
  access_request_enabled?: unknown;
  opus_dtx_enabled?: unknown;
  redundant_coding_enabled?: unknown;
};

type VideoSettingsOverrideInput = {
  enabled?: unknown;
  camera_default_on?: unknown;
  camera_facing?: unknown;
  access_request_enabled?: unknown;
  target_resolution?: {
    width?: unknown;
    height?: unknown;
    bitrate?: unknown;
  };
};

/**
 * Validates `settings_override.audio` against Stream's `AudioSettingsRequest`
 * schema (`mic_default_on`, `speaker_default_on`, `access_request_enabled`, and
 * `default_device` in `"speaker" | "earpiece"`).
 */
function assertValidAudioSettingsOverride(
  audio: AudioSettingsOverrideInput | undefined,
): void {
  if (audio === undefined) return;
  if (
    typeof audio.mic_default_on !== "boolean" ||
    typeof audio.speaker_default_on !== "boolean" ||
    typeof audio.access_request_enabled !== "boolean"
  ) {
    throw new StreamContractError(
      "GetOrCreateCall settings_override.audio requires boolean mic_default_on, speaker_default_on, and access_request_enabled",
    );
  }
  if (
    typeof audio.default_device !== "string" ||
    !AUDIO_DEFAULT_DEVICE_SET.has(audio.default_device)
  ) {
    throw new StreamContractError(
      `Invalid settings_override.audio.default_device "${String(audio.default_device)}". Allowed: ${STREAM_AUDIO_DEFAULT_DEVICES.join(", ")}`,
    );
  }
}

/**
 * Validates `settings_override.video` against Stream's `VideoSettingsRequest`
 * schema (`enabled`, `camera_default_on`, `access_request_enabled`, `camera_facing`,
 * and `target_resolution` with width >= 240, height >= 240, bitrate > 0).
 */
function assertValidVideoSettingsOverride(
  video: VideoSettingsOverrideInput | undefined,
): void {
  if (video === undefined) return;
  if (
    typeof video.enabled !== "boolean" ||
    typeof video.camera_default_on !== "boolean" ||
    typeof video.access_request_enabled !== "boolean"
  ) {
    throw new StreamContractError(
      "GetOrCreateCall settings_override.video requires boolean enabled, camera_default_on, and access_request_enabled",
    );
  }
  if (
    typeof video.camera_facing !== "string" ||
    !CAMERA_FACING_SET.has(video.camera_facing)
  ) {
    throw new StreamContractError(
      `Invalid settings_override.video.camera_facing "${String(video.camera_facing)}". Allowed: ${STREAM_CAMERA_FACING_VALUES.join(", ")}`,
    );
  }
  const res = video.target_resolution;
  const isValidResolution =
    Boolean(res) &&
    typeof res?.width === "number" &&
    Number.isFinite(res.width) &&
    res.width >= 240 &&
    typeof res?.height === "number" &&
    Number.isFinite(res.height) &&
    res.height >= 240 &&
    typeof res?.bitrate === "number" &&
    Number.isFinite(res.bitrate) &&
    res.bitrate > 0;
  if (!isValidResolution) {
    throw new StreamContractError(
      "GetOrCreateCall settings_override.video.target_resolution requires width >= 240, height >= 240, and bitrate > 0",
    );
  }
}

/**
 * Validates `call.getOrCreate(...)` payloads before invoking the Stream Video API,
 * catching missing `created_by_id`, invalid member roles, or incomplete
 * `settings_override.audio` / `settings_override.video` / `settings_override.limits`
 * shapes in unit tests and at runtime.
 */
export function assertValidGetOrCreateCall(request?: unknown): void {
  const req = request as
    | {
        data?: {
          created_by_id?: unknown;
          members?: ReadonlyArray<{ user_id?: unknown; role?: unknown }>;
          settings_override?: {
            backstage?: {
              enabled?: unknown;
              join_ahead_time_seconds?: unknown;
            };
            audio?: AudioSettingsOverrideInput;
            video?: VideoSettingsOverrideInput;
            limits?: {
              max_duration_seconds?: unknown;
              max_participants?: unknown;
              max_participants_exclude_owner?: unknown;
              max_participants_exclude_roles?: readonly unknown[];
            };
          };
          [key: string]: unknown;
        };
      }
    | null
    | undefined;

  const createdById = req?.data?.created_by_id;
  if (typeof createdById !== "string" || !createdById.trim()) {
    throw new StreamContractError(
      "GetOrCreateCall requires a non-empty data.created_by_id for server-side auth",
    );
  }
  if (req?.data?.members) {
    assertValidUpdateCallMembers({ update_members: req.data.members });
  }
  const joinAhead =
    req?.data?.settings_override?.backstage?.join_ahead_time_seconds;
  if (
    joinAhead !== undefined &&
    (typeof joinAhead !== "number" || !Number.isFinite(joinAhead) || joinAhead < 0)
  ) {
    throw new StreamContractError(
      "GetOrCreateCall requires a non-negative join_ahead_time_seconds",
    );
  }

  assertValidAudioSettingsOverride(req?.data?.settings_override?.audio);
  assertValidVideoSettingsOverride(req?.data?.settings_override?.video);

  const excludeRoles =
    req?.data?.settings_override?.limits?.max_participants_exclude_roles;
  if (Array.isArray(excludeRoles)) {
    for (const role of excludeRoles) {
      if (typeof role !== "string" || !CALL_MEMBER_ROLE_SET.has(role)) {
        throw new StreamContractError(
          `Invalid max_participants_exclude_roles role "${String(role)}"`,
        );
      }
    }
  }
}

