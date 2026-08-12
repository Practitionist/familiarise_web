/**
 * Shared Stream channel ID conventions and utilities.
 * All channel ID pattern detection should go through these helpers
 * to avoid scattered .startsWith()/.includes() checks.
 */

// Channel ID prefixes
export const DM_PREFIX = "dm-";
export const WEBINAR_PREFIX = "webinar-";
export const CLASS_PREFIX = "class-";
export const COLLAB_PREFIX = "collab-";
/**
 * Legacy only. #1134 P0-7 — nothing creates these any more.
 *
 * They were minted at payment and on approval, but `syncUserEventChannels` built
 * its expected set from webinars, classes and DMs alone while treating both
 * prefixes as MANAGED — so every one of them was classified stale and the buyer
 * was removed from it on their very next dashboard load. The concept never even
 * cohered internally: `createConsultationChannel` minted a DM, not a
 * `consultation-` channel. A pair now has exactly one thread per org context.
 *
 * The constants stay so `getChannelTypeFromId` can still resolve rows created
 * before the change; they are deliberately NOT in MANAGED_CHANNEL_PREFIXES, so
 * surviving channels are left alone rather than swept.
 */
export const CONSULTATION_PREFIX = "consultation-";
export const SUBSCRIPTION_PREFIX = "subscription-";

/** Prefixes managed by syncUserEventChannels for reconciliation */
export const MANAGED_CHANNEL_PREFIXES = [
  WEBINAR_PREFIX,
  CLASS_PREFIX,
  DM_PREFIX,
] as const;

/** Check if channel is a webinar or class event channel (group/team) */
export function isEventChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return (
    channelId.startsWith(WEBINAR_PREFIX) ||
    channelId.startsWith(CLASS_PREFIX)
  );
}

/** Check if channel is a direct message */
export function isDMChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return channelId.startsWith(DM_PREFIX);
}

/** Check if channel is a collaborator channel */
export function isCollaboratorChannel(
  channelId: string | undefined,
): boolean {
  if (!channelId) return false;
  return channelId.startsWith(COLLAB_PREFIX);
}

/**
 * Infer Stream channel type from channel ID prefix.
 * DM, collaborator, consultation, and subscription channels use "messaging".
 * Event channels (webinar, class) use "team".
 */
export function getChannelTypeFromId(
  channelId: string,
): "messaging" | "team" {
  if (
    channelId.startsWith(DM_PREFIX) ||
    channelId.startsWith(COLLAB_PREFIX) ||
    channelId.startsWith(CONSULTATION_PREFIX) ||
    channelId.startsWith(SUBSCRIPTION_PREFIX)
  ) {
    return "messaging";
  }
  return "team";
}
