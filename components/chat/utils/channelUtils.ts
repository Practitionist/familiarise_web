import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isSameYear,
} from "date-fns";
import type { Channel, ChannelState } from "stream-chat";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeOrgId } from "@/lib/api/scope/parse";
import { isSupportStreamUser } from "@/lib/stream/support-user";
import { withoutLegacyBookingCards } from "@/lib/stream/system-users";

export interface ChannelDisplayInfo {
  displayName: string;
  displayImage?: string;
  isGroupDM: boolean;
  memberCount: number;
  statusText: string;
  fullGroupName?: string; // For tooltips
  /** Familiarise Support is currently a member of this channel. */
  hasSupport: boolean;
}

type ChannelMembers = ChannelState["members"];
type ChannelMember = ChannelMembers[string];

const isSupportMember = (member: ChannelMember | undefined): boolean =>
  isSupportStreamUser(member?.user?.id ?? member?.user_id);

/** Support presence is read from membership only, never from channel data. */
export const membersIncludeSupport = (
  members: ChannelMembers | undefined | null,
): boolean => Object.values(members ?? {}).some(isSupportMember);

export const channelHasSupportMember = (channel: Channel): boolean =>
  membersIncludeSupport(channel.state?.members);

/** Members other than Familiarise Support, who joins visibly but is never a party. */
const partyMembers = (members: ChannelMembers | undefined): ChannelMember[] =>
  Object.values(members ?? {}).filter((member) => !isSupportMember(member));

/**
 * Is this a direct message that actually has someone on the other end?
 *
 * A `messaging` channel with fewer than two members is a phantom. They exist
 * because `channel.watch()` posts to the same endpoint `channel.create()` does,
 * so watching a channel id that does not exist yet CREATES it — with the caller
 * as `created_by` and no members at all. Every client-side path that could do
 * that is now gone, and `ensure-chat-type-grants.ts` revokes `create-channel`
 * from the `user` role so Stream itself refuses, but neither of those helps with
 * the ones already sitting on the app: dev, preview and production share one
 * Stream app, and a phantom is a real channel that a real message can be posted
 * into. `scripts/stream/purge-memberless-dms.ts` deletes them; this keeps them
 * off the screen in the meantime, and keeps any future one unreachable rather
 * than merely mislabelled.
 *
 * Deliberately scoped to `messaging`. A `team` channel legitimately sits at one
 * member — a webinar channel is created with its host before anyone registers —
 * so applying this to events would hide real, working channels.
 */
/**
 * Does the viewer own this channel?
 *
 * Both sides must exist. `ownerId === viewerId` is `true` when BOTH are
 * `undefined`, and both are reachable: `created_by` is absent on a channel
 * whose creator metadata did not come back from the query, and `client.userID`
 * is absent for the moment before the client connects. Together they granted
 * ownership to whoever happened to be looking — which in
 * `ChannelInfoAndManageDialog` gated the remove-member control, and that one
 * mutates.
 *
 * Lives here rather than inline because the same comparison had already been
 * written twice in that file and got this wrong both times.
 */
export const viewerOwnsChannel = (
  ownerId: string | undefined | null,
  viewerId: string | undefined | null,
): boolean => Boolean(ownerId) && Boolean(viewerId) && ownerId === viewerId;

export const isUsableDmChannel = (channel: Channel): boolean => {
  if (channel.type !== "messaging") return true;
  return partyMembers(channel.state?.members).length >= 2;
};

/**
 * Get consistent display information for any channel across all chat components
 */
export const getChannelDisplayInfo = (
  channel: Channel,
  currentUserId?: string,
): ChannelDisplayInfo => {
  const isTeamChannel = channel.type === "team";
  const isDirectMessage = channel.type === "messaging";
  const hasSupport = channelHasSupportMember(channel);

  if (isTeamChannel) {
    // Team channel logic
    const displayName = channel.data?.name || channel.id || "";
    const memberCount = Object.keys(channel.state.members || {}).length;

    return {
      displayName,
      displayImage: channel.data?.image as string,
      isGroupDM: false,
      memberCount,
      statusText: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
      hasSupport,
    };
  }

  if (isDirectMessage && currentUserId) {
    // Every party except the viewer; support never turns a 1:1 into a group.
    const otherMembers = partyMembers(channel.state.members)
      .filter((member) => member.user?.id !== currentUserId)
      .map((member) => member.user)
      .filter(Boolean);

    const isGroupDM = otherMembers.length > 1;
    const memberCount = otherMembers.length;

    if (isGroupDM) {
      // Group DM logic
      const firstTwoNames = otherMembers
        .slice(0, 2)
        .map((user) => user?.name || user?.id || "Unknown")
        .join(", ");

      let displayName: string;
      let fullGroupName: string;

      if (otherMembers.length > 2) {
        displayName = `${firstTwoNames} +${otherMembers.length - 2} more`;
        fullGroupName = otherMembers
          .map((user) => user?.name || user?.id || "Unknown")
          .join(", ");
      } else {
        displayName = firstTwoNames;
        fullGroupName = firstTwoNames;
      }

      return {
        displayName,
        displayImage: (otherMembers[0]?.image as string) || undefined,
        isGroupDM: true,
        memberCount,
        statusText: `${memberCount} members`,
        fullGroupName,
        hasSupport,
      };
    } else if (otherMembers.length === 1) {
      // 1-on-1 DM logic
      const otherMember = otherMembers[0];

      return {
        displayName: otherMember?.name || otherMember?.id || "Unknown User",
        displayImage: (otherMember?.image as string) || undefined,
        isGroupDM: false,
        memberCount: 1,
        statusText: otherMember?.online ? "Online" : "Offline",
        hasSupport,
      };
    }
  }

  // Fallback: a messaging channel with no counterparty, or no `currentUserId`
  // yet because the client is still connecting.
  //
  // This branch used to end in `channel.id`, which is why a broken DM rendered
  // its raw `dm-<cuid>-<cuid>` key as the conversation title. A channel id is an
  // internal key — it is never a name, it leaks both participants' user ids into
  // the UI, and showing it made a real defect (a channel created with no
  // members, see lib/stream/dm-eligibility.ts) look like a formatting quirk.
  //
  // A one-member DM should not exist. If one is on screen, say so plainly
  // instead of dressing it up, and keep the id out of the title.
  const isOrphanedDm = isDirectMessage;

  return {
    displayName:
      (channel.data?.name as string | undefined) ||
      (isOrphanedDm ? "Unavailable conversation" : channel.id || "Unknown"),
    displayImage: undefined,
    isGroupDM: false,
    memberCount: 0,
    statusText: isOrphanedDm ? "No other participants" : "No members",
    hasSupport,
  };
};

/**
 * Get truncated display name for headers with character limit
 */
export const getTruncatedDisplayName = (
  displayInfo: ChannelDisplayInfo,
  maxLength: number = 30,
): string => {
  if (displayInfo.displayName.length <= maxLength) {
    return displayInfo.displayName;
  }

  if (displayInfo.isGroupDM) {
    // For group DMs, try to show at least first name + indicator
    const parts = displayInfo.displayName.split(", ");
    if (parts.length >= 2) {
      const firstName = parts[0];
      const remaining = displayInfo.memberCount - 1;
      const truncated = `${firstName} +${remaining} more`;

      if (truncated.length <= maxLength) {
        return truncated;
      }
    }
  }

  // Generic truncation
  return displayInfo.displayName.substring(0, maxLength - 3) + "...";
};

/** When the viewer pinned this channel (ISO), or null. `overrides` holds pins changed since the list loaded. */
export function channelPinnedAt(
  channel: Channel,
  overrides: Readonly<Record<string, string | null>> = {},
): string | null {
  if (channel.cid in overrides) return overrides[channel.cid];
  return channel.state?.membership?.pinned_at ?? null;
}

/**
 * Pinned channels first, the most recently pinned on top, then the rest in the
 * order given (the list is already newest-activity first, and this is stable).
 * Returns `channels` itself when nothing is pinned.
 */
export function pinnedFirst(
  channels: Channel[],
  overrides: Readonly<Record<string, string | null>> = {},
): Channel[] {
  const pinned = channels.filter((ch) => channelPinnedAt(ch, overrides));
  if (pinned.length === 0) return channels;
  pinned.sort(
    (a, b) =>
      new Date(channelPinnedAt(b, overrides)!).getTime() -
      new Date(channelPinnedAt(a, overrides)!).getTime(),
  );
  return [...pinned, ...channels.filter((ch) => !pinned.includes(ch))];
}

/**
 * The time a list row shows, in the viewer's zone: the clock time today, then
 * "Yesterday", the weekday within the last week, then the date.
 */
export function formatRowTime(
  when: Date | string,
  now: Date = new Date(),
): string {
  const date = new Date(when);
  if (isSameDay(date, now) || date > now) return format(date, "h:mm a");
  const daysAgo = differenceInCalendarDays(now, date);
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo < 7) return format(date, "EEE");
  return format(date, isSameYear(date, now) ? "d MMM" : "d MMM yyyy");
}

/** Shortest term the chat search acts on, shared by the sidebar filter and the server search. */
export const MIN_SEARCH_LENGTH = 2;

/**
 * The channels whose listed title contains `term`, case-insensitively.
 *
 * Matches only what the row shows (the other person's name, a group's members, an
 * event's name), so a filtered list never contains a row that looks unrelated.
 * Returns `channels` itself while `term` is too short to filter by.
 */
export function filterChannelsByTerm(
  channels: Channel[],
  viewerId: string | undefined,
  term: string,
): Channel[] {
  const needle = term.trim().toLowerCase();
  if (needle.length < MIN_SEARCH_LENGTH) return channels;
  return channels.filter((channel) => {
    const { displayName, fullGroupName } = getChannelDisplayInfo(
      channel,
      viewerId,
    );
    return `${displayName} ${fullGroupName ?? ""}`
      .toLowerCase()
      .includes(needle);
  });
}

/**
 * The `?orgScope=` selection as a Stream channel filter. Stream channels
 * created by the enterprise wiring carry a `custom.organization_id`, and
 * without this a consultant in Acme + Zeta sees every chat cross-tenanted in
 * one inbox (#674). Lives here rather than inline in ChatSidebar so the
 * initial fetch and the load-more page share one definition and can never
 * disagree about which tenant is on screen.
 *
 * #674 B2B gap 9 — `orgMember` (what an active member below `operations.read`
 * resolves to) pins an org exactly as `org` does, so the question goes through
 * `scopeOrgId`. Branching on `kind === "org"` alone left that member
 * unfiltered: picking one org showed the whole cross-tenant inbox this filter
 * exists to prevent. Only `all` is genuinely unfiltered.
 */
export function buildOrgChannelFilter(scope: Scope): Record<string, unknown> {
  if (scope.kind === "personal") return { organization_id: { $exists: false } };
  const pinnedOrgId = scopeOrgId(scope);
  return pinnedOrgId ? { organization_id: { $eq: pinnedOrgId } } : {};
}

/** The class or webinar channel subtitle: who hosts it, how many others, and who can read it. */
export function eventChannelSubtitle({
  eventType,
  hostName,
  memberCount,
}: {
  eventType: "webinar" | "class";
  hostName: string | null;
  memberCount: number;
}): string {
  const noun = eventType === "class" ? "classmate" : "attendee";
  const count = hostName ? Math.max(0, memberCount - 1) : memberCount;
  const people = `${count} ${noun}${count === 1 ? "" : "s"}`;
  return [
    "group chat",
    hostName ? `${hostName} (host) + ${people}` : people,
    `Everyone in this ${eventType} can read this`,
  ].join(" · ");
}

/** The latest message a channel row previews; retired booking cards never count. */
export function lastVisibleMessage<T extends { user?: { id?: string } | null }>(
  messages: T[],
): T | null {
  return withoutLegacyBookingCards(messages).at(-1) ?? null;
}
