"use client";

// Helper function to safely get a string property from an object
function getStringFromData(data: unknown, key: string, defaultValue: string | undefined = undefined): string | undefined {
  if (data && typeof data === 'object' && data !== null) {
    // We've confirmed data is an object. Now, treat it as a record for property access.
    const record = data as Record<string, unknown>;
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return defaultValue;
}

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useChatContext } from "stream-chat-react";
import { ChannelInfoAndManageDialog } from "./ChannelInfoAndManageDialog";

export const CustomChannelHeader = () => {
  const { channel, client } = useChatContext();

  if (!channel) return null;

  const isDirectMessage = channel.type === "messaging";

  if (isDirectMessage) {
    // Find the other member in the channel
    const otherMember = Object.values(channel.state.members || {}).find(
      (member) => member.user?.id !== client?.userID,
    )?.user;

    const displayName = otherMember?.name || otherMember?.id || "Unknown User";
    const displayImage = (otherMember?.image as string) || undefined;
    const isOnline = otherMember?.online || false;

    return (
      <div className="flex items-center px-4 py-2 border-b">
        <Avatar className="h-8 w-8 mr-3">
          <AvatarImage src={displayImage || "/placeholder-user.jpg"} />
          <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
        </Avatar>

        <div className="flex-1">
          <div className="font-medium">{displayName}</div>
          <div className="text-xs text-gray-500">
            {isOnline ? "Online" : "Offline"}
          </div>
        </div>

        <ChannelInfoAndManageDialog channel={channel} />
      </div>
    );
  }

  // For team channels, use the default display
  const displayName = getStringFromData(channel.data, 'name') ?? channel.id ?? "";
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
