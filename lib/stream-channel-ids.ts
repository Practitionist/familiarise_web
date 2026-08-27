/**
 * Shared Stream channel ID conventions and utilities.
 * All channel ID pattern detection should go through these helpers
 * to avoid scattered .startsWith()/.includes() checks.
 */

// Channel ID prefixes
export const DM_PREFIX = "dm-";
/**
 * Org-scoped and overflow DM forms, both minted by `getDmChannelId`.
 *
 * These are NOT covered by `DM_PREFIX`: `"dmo-".startsWith("dm-")` is false, so
 * before they were declared here `getChannelTypeFromId` resolved every
 * org-context DM as `team` — a channel created as `messaging` — and
 * `MANAGED_CHANNEL_PREFIXES` skipped them entirely, so the reconciler never
 * touched them. Any new DM shape must be added here as well as in
 * `lib/stream-utils.ts`, or it silently falls into the `team` arm below.
 */
export const DM_ORG_PREFIX = "dmo-";
export const DM_HASHED_PREFIX = "dmh-";
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

/**
 * Prefixes managed by syncUserEventChannels for reconciliation.
 *
 * Adding a prefix here makes the reconciler REMOVE the user from any channel
 * carrying it that is absent from `expectedChannelIds`. So a prefix only
 * belongs here once `getDmPairsForUser` / `getWebinarIdsForUser` /
 * `getClassIdsForUser` are guaranteed to produce every legitimate id under it —
 * otherwise the sweep deletes live conversations, which is #1134 P0-7 all over
 * again. `dmo-`/`dmh-` are safe here because `getDmPairsForUser` derives its
 * ids through the same `getDmChannelId` helper that mints them, over the same
 * `DM_ELIGIBLE_STATUSES` set the eligibility gate uses.
 */
export const MANAGED_CHANNEL_PREFIXES = [
  WEBINAR_PREFIX,
  CLASS_PREFIX,
  DM_PREFIX,
  DM_ORG_PREFIX,
  DM_HASHED_PREFIX,
] as const;

/** Check if channel is a webinar or class event channel (group/team) */
export function isEventChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return (
    channelId.startsWith(WEBINAR_PREFIX) ||
    channelId.startsWith(CLASS_PREFIX)
  );
}

/** Check if channel is a direct message, in any of its three id forms */
export function isDMChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return (
    channelId.startsWith(DM_PREFIX) ||
    channelId.startsWith(DM_ORG_PREFIX) ||
    channelId.startsWith(DM_HASHED_PREFIX)
  );
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
 * DM (all three forms), collaborator, consultation, and subscription channels
 * use "messaging". Event channels (webinar, class) use "team".
 *
 * The `team` return is a FALLBACK, not a match — an unrecognised prefix lands
 * there. That is why `dmo-` resolved as `team` for as long as it went
 * undeclared: nothing errors, the wrong type is simply handed to
 * `client.channel(type, id)`, which then addresses a channel that does not
 * exist and 404s or creates a second one.
 */
export function getChannelTypeFromId(
  channelId: string,
): "messaging" | "team" {
  if (
    isDMChannel(channelId) ||
    channelId.startsWith(COLLAB_PREFIX) ||
    channelId.startsWith(CONSULTATION_PREFIX) ||
    channelId.startsWith(SUBSCRIPTION_PREFIX)
  ) {
    return "messaging";
  }
  return "team";
}
