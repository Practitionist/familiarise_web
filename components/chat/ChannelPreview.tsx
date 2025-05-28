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
import { format } from "date-fns";
import type { Channel, ChannelMemberResponse } from "stream-chat";
import { useChatContext } from "stream-chat-react";

type ChannelPreviewProps = {
  channel: Channel;
  type: "team" | "messaging";
  setActiveChannel?: (channel: Channel) => void;
  setIsCreating?: (isCreating: boolean) => void;
};

export const ChannelPreview = ({
  channel,
  type,
  setActiveChannel,
  setIsCreating,
}: ChannelPreviewProps) => {
  const { channel: activeChannel, client } = useChatContext();

  const isActive = activeChannel?.id === channel.id;
  const isDirectMessage = type === "messaging";

  // For direct messages, get the other user's details
  const otherMember = isDirectMessage
    ? Object.values(channel.state.members || {}).find(
        // Correctly type member as ChannelMemberResponse
        (member: ChannelMemberResponse) => 
          member.user?.id !== client.userID, // Direct access to user.id
      )?.user // otherMember is UserResponse | undefined
    : null;

  const displayName = isDirectMessage
    // Direct access to name and id from otherMember (UserResponse)
    ? (otherMember?.name ?? otherMember?.id ?? "Unknown User") 
    // Safe access for custom channel name, fallback to channel.id
    : (getStringFromData(channel.data, 'name') ?? channel.id ?? "");

  const displayImage = isDirectMessage
    // Direct access to image from otherMember (UserResponse)
    ? otherMember?.image 
    // Safe access for custom channel image
    : getStringFromData(channel.data, 'image');

  const lastMessage = channel.state.messages[channel.state.messages.length - 1];
  const lastMessageText =
    lastMessage?.text?.substring(0, 20) ?? "No messages yet";
  const lastMessageTime = lastMessage?.created_at
    ? format(new Date(lastMessage.created_at), "h:mm a")
    : "";

  const handleClick = () => {
    if (setIsCreating) {
      setIsCreating(false);
    }

    if (setActiveChannel) {
      setActiveChannel(channel);
    }
  };

  if (isDirectMessage) {
    return (
      <button
        className={`px-4 py-2 flex items-center gap-3 hover:bg-blue-700 transition-colors cursor-pointer w-full text-left ${
          isActive ? "bg-blue-700" : ""
        }`}
        onClick={handleClick}
      >
        <Avatar className="h-8 w-8">
          <AvatarImage src={displayImage as string} />
          <AvatarFallback className="bg-blue-400 text-white">
            {displayName.charAt(0)}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{displayName}</div>
          <div className="text-xs text-blue-200 truncate">
            {lastMessageText}
          </div>
        </div>

        {lastMessageTime && (
          <div className="text-xs text-blue-200">{lastMessageTime}</div>
        )}
      </button>
    );
  }

  // Team channel preview
  return (
    <button
      className={`px-4 py-2 flex items-center hover:bg-blue-700 transition-colors cursor-pointer w-full text-left ${
        isActive ? "bg-blue-700" : ""
      }`}
      onClick={handleClick}
    >
      <div className="flex items-center w-full">
        <span className="text-blue-200 mr-2">#</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{displayName}</div>
          {lastMessage && (
            <div className="text-xs text-blue-200 truncate">
              {lastMessageText}
            </div>
          )}
        </div>
      </div>
    </button>
  );
};
