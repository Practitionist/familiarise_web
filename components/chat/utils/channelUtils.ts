import type { Channel } from "stream-chat";

export interface ChannelDisplayInfo {
  displayName: string;
  displayImage?: string;
  isGroupDM: boolean;
  memberCount: number;
  statusText: string;
  fullGroupName?: string; // For tooltips
}

/**
 * Get consistent display information for any channel across all chat components
 */
export const getChannelDisplayInfo = (
  channel: Channel,
  currentUserId?: string,
): ChannelDisplayInfo => {
  const isTeamChannel = channel.type === "team";
  const isDirectMessage = channel.type === "messaging";

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
    };
  }

  if (isDirectMessage && currentUserId) {
    // Get all members except current user
    const otherMembers = Object.values(channel.state.members || {})
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
      };
    }
  }

  // Fallback
  return {
    displayName: channel.data?.name || channel.id || "Unknown",
    displayImage: undefined,
    isGroupDM: false,
    memberCount: 0,
    statusText: "No members",
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
