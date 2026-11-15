/**
 * The checked-in Stream control-plane contract: the intended state of the Stream
 * app that lives outside this repo. `scripts/stream/ensure*.ts` write it and
 * `lib/stream/control-plane-drift.ts` reads it, so the two cannot diverge.
 * Pure data and predicates only: no I/O, no SDK imports.
 */
import { CALL_MEMBER_ROLE } from "@/lib/stream/call-cid";
import { compareStringsByCodeUnit } from "@/lib/stream/config-fingerprint";
import { DESIRED_EVENT_TYPES } from "@/lib/stream/webhook-events";

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export const TARGET_APP_SETTINGS = {
  guestUserCreationDisabled: true,
  /** Write-only on Stream: it can be applied but never read back. */
  enableHookPayloadCompression: false,
} as const;

// ---------------------------------------------------------------------------
// Chat unread reminders
// ---------------------------------------------------------------------------

/**
 * Stream emits `user.unread_message_reminder` only for a channel type with
 * `reminders` and `read_events` on; the interval equals the digest window.
 */
export const TARGET_CHAT_REMINDERS = {
  channelType: "messaging",
  remindersIntervalSeconds: 1800,
} as const;

export interface ChannelConfigLike {
  reminders?: boolean;
  read_events?: boolean;
}

/** Finding keys for the reminder settings; empty when they match the contract. */
export function chatReminderFindings(app: {
  reminders_interval?: number;
  channel_configs?: Record<string, ChannelConfigLike>;
}): string[] {
  const type = TARGET_CHAT_REMINDERS.channelType;
  const config = app.channel_configs?.[type];
  const findings: string[] = [];
  if (config?.reminders !== true)
    findings.push(`channel_type:${type}:reminders`);
  if (config?.read_events !== true) {
    findings.push(`channel_type:${type}:read_events`);
  }
  if (
    app.reminders_interval !== TARGET_CHAT_REMINDERS.remindersIntervalSeconds
  ) {
    findings.push("app:reminders_interval");
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Webhook hook
// ---------------------------------------------------------------------------

export const STREAM_WEBHOOK_PATH = "/api/stream/webhooks";

/** Every hook delivers to the production origin; `appUrl` is `NEXT_PUBLIC_APP_URL`. */
export function expectedWebhookUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}${STREAM_WEBHOOK_PATH}`;
}

export const SORTED_DESIRED_EVENT_TYPES = Array.from(
  new Set(DESIRED_EVENT_TYPES),
).sort(compareStringsByCodeUnit);

export interface HookLike {
  id?: string;
  enabled?: boolean;
  hook_type?: string;
  product?: string;
  webhook_url?: string;
  event_types?: string[];
}

const CHAT_EVENT_PREFIXES = ["user.", "message.", "channel.", "member."];

export function productFor(eventType: string): "chat" | "video" {
  return CHAT_EVENT_PREFIXES.some((p) => eventType.startsWith(p))
    ? "chat"
    : "video";
}

/** One webhook hook per product, each carrying exactly that product's handled events. */
export function desiredEventTypesByProduct(): Record<
  "chat" | "video",
  typeof SORTED_DESIRED_EVENT_TYPES
> {
  return {
    chat: SORTED_DESIRED_EVENT_TYPES.filter((t) => productFor(t) === "chat"),
    video: SORTED_DESIRED_EVENT_TYPES.filter((t) => productFor(t) === "video"),
  };
}

export function hookProduct(hook: HookLike): string | undefined {
  return typeof hook.product === "string" ? hook.product : undefined;
}

export function hookAccepts(hook: HookLike, eventType: string): boolean {
  const product = hookProduct(hook);
  if (!product || product === "all") return true;
  return product === productFor(eventType);
}

export interface HookDriftReport {
  product: string;
  receivesAll: boolean;
  missing: string[];
  extra: string[];
  disabled: boolean;
  urlMismatch: boolean;
  hasDrift: boolean;
}

/** `expectedUrl` is omitted when the origin is unknown, which skips the URL comparison. */
export function evaluateHookDrift(
  hook: HookLike,
  eligible: readonly string[],
  expectedUrl?: string,
): HookDriftReport {
  const rawTypes = hook.event_types ?? [];
  const current = new Set(rawTypes);
  const receivesAll = rawTypes.length === 0 || current.has("*");
  const eligibleSet = new Set(eligible);
  const missing = receivesAll ? [] : eligible.filter((t) => !current.has(t));
  const extra = [...current].filter((t) => t !== "*" && !eligibleSet.has(t));
  const product = hookProduct(hook) ?? "unscoped";
  const disabled = hook.enabled === false;
  const urlMismatch =
    expectedUrl !== undefined && hook.webhook_url !== expectedUrl;
  const hasDrift =
    eligible.length > 0 &&
    (receivesAll ||
      missing.length > 0 ||
      extra.length > 0 ||
      disabled ||
      urlMismatch);
  return {
    product,
    receivesAll,
    missing,
    extra,
    disabled,
    urlMismatch,
    hasDrift,
  };
}

// ---------------------------------------------------------------------------
// Permission vocabulary
// ---------------------------------------------------------------------------

/** Matches a permission or its `-owner` / `-any-team` scoped variants against a base permission list. */
export function matchesPermissionWithScope(
  perm: string,
  basePermissions: readonly string[],
): boolean {
  return basePermissions.some(
    (base) =>
      perm === base || perm === `${base}-owner` || perm === `${base}-any-team`,
  );
}

export const REACH_PERMISSIONS = [
  "create-call",
  "create-call-any-team",
  "join-call",
  "join-call-any-team",
  "join-backstage",
  "join-backstage-any-team",
  "join-ended-call",
  "join-ended-call-any-team",
];

export const BILLABLE_PERMISSIONS = [
  "start-recording",
  "stop-recording",
  "start-frame-recording",
  "stop-frame-recording",
  "start-raw-recording",
  "stop-raw-recording",
  "start-individual-recording",
  "stop-individual-recording",
  "start-transcription",
  "stop-transcription",
  "start-closed-captions",
  "stop-closed-captions",
  "start-broadcasting",
  "stop-broadcasting",
  "start-rtmp-broadcasts",
  "stop-rtmp-broadcast",
  "stop-all-rtmp-broadcasts",
  "use-noise-cancellation",
  "enable-noise-cancellation",
];

// ---------------------------------------------------------------------------
// Unused built-in call types
// ---------------------------------------------------------------------------

export const UNUSED_CALL_TYPES = [
  "livestream",
  "audio_room",
  "development",
] as const;

export const END_USER_ROLES = [
  "user",
  "guest",
  "anonymous",
  "speaker",
  "host",
  "call_member",
];

const UNUSED_TYPE_STRIP_BASE = [...REACH_PERMISSIONS, ...BILLABLE_PERMISSIONS];

export function shouldStripFromUnusedCallType(perm: string): boolean {
  return matchesPermissionWithScope(perm, UNUSED_TYPE_STRIP_BASE);
}

/** The grants an unused call type must hold: end-user roles lose reach and billable permissions. */
export function hardenedUnusedTypeGrants(
  grants: Record<string, string[]>,
): Record<string, string[]> {
  const next: Record<string, string[]> = { ...grants };
  for (const role of END_USER_ROLES) {
    const held = next[role];
    if (held) {
      next[role] = held.filter((perm) => !shouldStripFromUnusedCallType(perm));
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// The `default` call type
// ---------------------------------------------------------------------------

export const CREATE_CALL = "create-call";
export const JOIN_CALL = "join-call";
export const END_CALL = "end-call";
export const LIST_RECORDINGS = "list-recordings";
export const JOIN_REVOKED_ROLES = ["user", "guest"];
export const RECORDING_REVOKED_ROLES = [
  ...JOIN_REVOKED_ROLES,
  CALL_MEMBER_ROLE,
];

const NON_MEMBER_REVOKED_PERMISSIONS = [
  JOIN_CALL,
  "join-ended-call",
  "update-call-permissions",
];

export const DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS = [
  ...BILLABLE_PERMISSIONS,
  CREATE_CALL,
  END_CALL,
  LIST_RECORDINGS,
];

/**
 * Member management happens server-side as admin (join route, collaborator
 * service), so `user` and `call_member` hold only the creator-scoped variants.
 */
export const OWNER_ONLY_MEMBER_PERMISSIONS = [
  "remove-call-member",
  "update-call-member",
];

/**
 * A conduct removal ends the seat, records the reason and opens a support review,
 * so no client role kicks or blocks inside a call; the server does both as admin.
 */
const SERVER_ONLY_CALL_MODERATION = ["kick-user", "block-user"];

/**
 * A sealed room stays sealed at Stream: reopening rotates to a fresh call id, so no
 * member ever needs to join a call Stream has ended.
 */
export const JOIN_ENDED_CALL = "join-ended-call";

export function isRevokedClientPermission(perm: string): boolean {
  return matchesPermissionWithScope(
    perm,
    DEFAULT_CALL_TYPE_REVOKED_PERMISSIONS,
  );
}

function isRevokedNonMemberPermission(perm: string): boolean {
  return (
    matchesPermissionWithScope(perm, NON_MEMBER_REVOKED_PERMISSIONS) ||
    isRevokedClientPermission(perm)
  );
}

function ownerScoped(held: string[]): string[] {
  const next = held.filter((p) => !OWNER_ONLY_MEMBER_PERMISSIONS.includes(p));
  for (const base of OWNER_ONLY_MEMBER_PERMISSIONS) {
    if (held.includes(base) && !next.includes(`${base}-owner`)) {
      next.push(`${base}-owner`);
    }
  }
  return next;
}

/** The grants the `default` call type must hold, derived from what it holds now. */
export function intendedDefaultCallTypeGrants(
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const grants: Record<string, string[]> = { ...existing };

  for (const role of JOIN_REVOKED_ROLES) {
    const held = grants[role];
    if (held)
      grants[role] = held.filter((g) => !isRevokedNonMemberPermission(g));
  }
  for (const role of RECORDING_REVOKED_ROLES) {
    const held = grants[role];
    if (held) grants[role] = held.filter((g) => !isRevokedClientPermission(g));
  }
  for (const role of ["user", CALL_MEMBER_ROLE]) {
    const held = grants[role];
    if (held)
      grants[role] = ownerScoped(held).filter(
        (g) => !matchesPermissionWithScope(g, SERVER_ONLY_CALL_MODERATION),
      );
  }

  const memberGrants = (grants[CALL_MEMBER_ROLE] ?? []).filter(
    (g) => !matchesPermissionWithScope(g, [JOIN_ENDED_CALL]),
  );
  grants[CALL_MEMBER_ROLE] = memberGrants;
  if (!memberGrants.includes(JOIN_CALL)) {
    grants[CALL_MEMBER_ROLE] = [...memberGrants, JOIN_CALL];
  }
  return grants;
}

// ---------------------------------------------------------------------------
// co_presenter role and session settings
// ---------------------------------------------------------------------------

export const TARGET_INACTIVITY_TIMEOUT_SECONDS = 300;

/** Publish plus mute, pin and backstage; never end-call, permission changes or billable starts. */
export const CO_PRESENTER_GRANTS = [
  "create-call-reaction",
  "join-backstage",
  "join-call",
  "list-recordings",
  "list-transcriptions",
  "mute-users",
  "pin-call-track",
  "read-call",
  "screenshare",
  "send-audio",
  "send-closed-captions",
  "send-event",
  "send-video",
];

export function matchesCoPresenterGrants(
  grants: readonly string[] | undefined,
): boolean {
  const held = new Set(grants ?? []);
  return (
    held.size === CO_PRESENTER_GRANTS.length &&
    CO_PRESENTER_GRANTS.every((perm) => held.has(perm))
  );
}

// ---------------------------------------------------------------------------
// The `messaging` chat channel type
// ---------------------------------------------------------------------------

export const MESSAGING_CHANNEL_TYPE = "messaging";

/**
 * Owner-scoped grants a channel's `created_by` must not hold. Membership and history
 * change only through server actions that authorise against Postgres.
 */
export const MESSAGING_USER_REVOKED_GRANTS = [
  "truncate-channel-owner",
  "delete-channel-owner",
  "update-channel-members-owner",
  "recreate-channel-owner",
  "update-channel-owner",
];

/** The `messaging` grants it must hold: the `user` role loses the owner grants above, every other grant is kept. */
export function intendedMessagingGrants(
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const grants: Record<string, string[]> = { ...existing };
  if (grants.user) {
    grants.user = grants.user.filter(
      (perm) => !MESSAGING_USER_REVOKED_GRANTS.includes(perm),
    );
  }
  return grants;
}

// ---------------------------------------------------------------------------
// Grant diffing
// ---------------------------------------------------------------------------

/** `role:permission` keys present in exactly one of the two grant maps. */
export function grantDifferences(
  actual: Record<string, string[]>,
  intended: Record<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const role of new Set([
    ...Object.keys(actual),
    ...Object.keys(intended),
  ])) {
    const have = new Set(actual[role] ?? []);
    const want = new Set(intended[role] ?? []);
    for (const perm of have) if (!want.has(perm)) out.push(`${role}:${perm}`);
    for (const perm of want) if (!have.has(perm)) out.push(`${role}:-${perm}`);
  }
  return out.sort(compareStringsByCodeUnit);
}
