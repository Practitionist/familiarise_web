"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useChatContext } from "stream-chat-react";
import { ChannelInfoAndManageDialog } from "./ChannelInfoAndManageDialog";

export const CustomChannelHeader = () => {
  const { channel, client } = useChatContext();

  if (!channel) return null;

  const isDirectMessage = channel.type === "messaging";

  if (isDirectMessage) {
    // Get all members except current user
    const otherMembers = Object.values(channel.state.members || {})
      .filter((member) => member.user?.id !== client?.userID)
      .map((member) => member.user)
      .filter(Boolean);

    const isGroupDM = otherMembers.length > 1;
    let displayName: string;
    let displayImage: string | undefined;
    let statusText: string;

    if (isGroupDM) {
      // Group DM: Show first few names + count if needed
      const firstTwoNames = otherMembers
        .slice(0, 2)
        .map((user) => user?.name || user?.id || "Unknown")
        .join(", ");
      
      if (otherMembers.length > 2) {
        displayName = `${firstTwoNames} +${otherMembers.length - 2} more`;
      } else {
        displayName = firstTwoNames;
      }
      
      // For group DMs, use the first member's image and show member count
      displayImage = (otherMembers[0]?.image as string) || undefined;
      statusText = `${otherMembers.length} members`;
    } else if (otherMembers.length === 1) {
      // 1-on-1 DM: Use the other user's details
      const otherMember = otherMembers[0];
      displayName = otherMember?.name || otherMember?.id || "Unknown User";
      displayImage = (otherMember?.image as string) || undefined;
      statusText = otherMember?.online ? "Online" : "Offline";
    } else {
      // Fallback for empty channels
      displayName = "Unknown";
      displayImage = undefined;
      statusText = "No members";
    }

    return (
      <div className="flex items-center px-4 py-2 border-b">
        <div className="relative mr-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={displayImage || "/placeholder-user.jpg"} />
            <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          {isGroupDM && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-blue-500 rounded-full border border-blue-600 flex items-center justify-center">
              <span className="text-[8px] text-white font-bold">G</span>
            </div>
          )}
        </div>

        <div className="flex-1">
          <div className="font-medium">{displayName}</div>
          <div className="text-xs text-gray-500">
            {statusText}
          </div>
        </div>

        <ChannelInfoAndManageDialog channel={channel} />
      </div>
    );
  }

  // For team channels, use the default display
  const displayName = channel.data?.name || channel.id || "";
  const memberCount = Object.keys(channel.state.members || {}).length;

  return (
    <div className="flex items-center px-4 py-2 border-b">
      <div className="flex items-center mr-3">
        <span className="text-gray-500 mr-2">#</span>
      </div>

      <div className="flex-1">
        <div className="font-medium">{displayName}</div>
        <div className="text-xs text-gray-500">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </div>
      </div>

      <ChannelInfoAndManageDialog channel={channel} />
    </div>
  );
};
