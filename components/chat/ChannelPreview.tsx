"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useChatContext } from "stream-chat-react";
import type { Channel } from "stream-chat";

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
        (member: Record<string, unknown>) => (member.user as any)?.id !== client.userID
      )?.user
    : null;
  
  const displayName = isDirectMessage
    ? (otherMember as any)?.name ?? (otherMember as any)?.id ?? "Unknown User"
    : channel.data?.name ?? channel.id ?? "";
  
  const displayImage = isDirectMessage
    ? (otherMember as any)?.image
    : channel.data?.image;
  
  const lastMessage = channel.state.messages[channel.state.messages.length - 1];
  const lastMessageText = lastMessage?.text?.substring(0, 20) ?? "No messages yet";
  
  const handleClick = () => {
    if (setIsCreating) {
      setIsCreating(false);
    }
    
    if (setActiveChannel) {
      setActiveChannel(channel);
    }
  };
  
  return (
    <button
      className={`px-4 py-2 flex items-center gap-3 hover:bg-blue-700 transition-colors cursor-pointer w-full text-left ${
        isActive ? "bg-blue-700" : ""
      }`}
      onClick={handleClick}
    >
      <Avatar>
        <AvatarImage src={displayImage as string} />
        <AvatarFallback className="bg-blue-400 text-white">
          {displayName.charAt(0)}
        </AvatarFallback>
      </Avatar>
      
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{displayName}</div>
        <div className="text-xs text-blue-200 truncate">{lastMessageText}</div>
      </div>
    </button>
  );
};
