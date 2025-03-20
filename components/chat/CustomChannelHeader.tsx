"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { InfoIcon } from "lucide-react";
import { useChatContext } from "stream-chat-react";

export const CustomChannelHeader = () => {
  const { channel, client } = useChatContext();
  
  if (!channel) return null;
  
  const isDirectMessage = channel.type === "messaging";
  
  if (isDirectMessage) {
    // Find the other member in the channel
    const otherMember = Object.values(channel.state.members || {}).find(
      (member) => member.user?.id !== client?.userID
    )?.user;
    
    const displayName = otherMember?.name || otherMember?.id || "Unknown User";
    const displayImage = otherMember?.image as string || undefined;
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
        
        <button className="p-2 rounded-full hover:bg-gray-100">
          <InfoIcon className="h-5 w-5 text-gray-500" />
        </button>
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
      
      <button className="p-2 rounded-full hover:bg-gray-100">
        <InfoIcon className="h-5 w-5 text-gray-500" />
      </button>
    </div>
  );
};
