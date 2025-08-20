"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useChatContext } from "stream-chat-react";
import { ChannelInfoAndManageDialog } from "./ChannelInfoAndManageDialog";
import { getChannelDisplayInfo, getTruncatedDisplayName } from "./utils/channelUtils";

export const CustomChannelHeader = () => {
  const { channel, client } = useChatContext();

  if (!channel) return null;

  const isDirectMessage = channel.type === "messaging";

  if (isDirectMessage) {
    const displayInfo = getChannelDisplayInfo(channel, client?.userID);
    const truncatedName = getTruncatedDisplayName(displayInfo, 35);
    const showTooltip = truncatedName !== displayInfo.displayName;

    return (
      <div className="flex items-center px-4 py-2 border-b">
        <div className="relative mr-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={displayInfo.displayImage || "/placeholder-user.jpg"} />
            <AvatarFallback>{displayInfo.displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          {displayInfo.isGroupDM && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-blue-500 rounded-full border border-blue-600 flex items-center justify-center">
              <span className="text-[8px] text-white font-bold">G</span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div 
            className="font-medium truncate"
            title={showTooltip ? (displayInfo.fullGroupName || displayInfo.displayName) : undefined}
          >
            {truncatedName}
          </div>
          <div className="text-xs text-gray-500">
            {displayInfo.statusText}
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
