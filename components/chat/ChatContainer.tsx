"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Channel,
  MessageInput,
  MessageList,
  VirtualizedMessageList,
  Thread,
  Window,
  useChatContext,
} from "stream-chat-react";
import { CustomChannelHeader } from "./CustomChannelHeader";
import { CustomMessage } from "./CustomMessage";
import { StreamChatErrorBoundary } from "@/components/stream/StreamErrorBoundary";

// Empty state component for when no channel is selected
const EmptyChannelState = () => (
  <div className="flex flex-col items-center justify-center h-full p-8 text-center text-gray-500">
    <MessageSquareIcon className="w-16 h-16 mb-4 opacity-50" />
    <h3 className="text-lg font-medium mb-2">No channel selected</h3>
    <p className="text-sm">
      Select a channel from the sidebar to start chatting
    </p>
  </div>
);

export const ChatContainer = () => {
  const { channel } = useChatContext();
  const [hasChannel, setHasChannel] = useState(false);
  const [shouldUseVirtualized, setShouldUseVirtualized] = useState(false);

  useEffect(() => {
    setHasChannel(!!channel);
    
    if (channel) {
      // Determine if we should use virtualized list based on:
      // 1. Channel member count (>10 members suggests group chat)
      // 2. Channel type (team channels are typically higher traffic)
      // 3. Message count estimation
      const memberCount = Object.keys(channel.state.members || {}).length;
      const messageCount = channel.state.messages.length;
      const isTeamChannel = channel.type === 'team';
      
      // Use virtualized list for:
      // - Team channels with >5 members
      // - Any channel with >100 messages currently loaded
      // - Webinar/class channels (identified by channel ID pattern)
      const isHighTrafficChannel = 
        (isTeamChannel && memberCount > 5) ||
        messageCount > 100 ||
        channel.id?.includes('webinar-') ||
        channel.id?.includes('class-');
      
      setShouldUseVirtualized(isHighTrafficChannel || false);
      
      console.log(`Channel ${channel.id}: members=${memberCount}, messages=${messageCount}, type=${channel.type}, useVirtualized=${isHighTrafficChannel}`);
    }
  }, [channel]);

  if (!hasChannel) {
    return <EmptyChannelState />;
  }

  // Choose the appropriate MessageList component based on channel traffic
  const MessageListComponent = shouldUseVirtualized ? VirtualizedMessageList : MessageList;
  
  // For VirtualizedMessageList, we need to set defaultItemHeight for optimal performance
  const messageListProps = shouldUseVirtualized 
    ? { 
        Message: CustomMessage,
        defaultItemHeight: 62, // Typical height of a one-line message
        additionalVirtuosoProps: {
          // Additional performance optimizations
          increaseViewportBy: 200, // Render 200px outside viewport
          overscan: 5, // Keep 5 extra items rendered
        }
      }
    : { Message: CustomMessage };

  return (
    <StreamChatErrorBoundary>
      <div className="flex-1 flex flex-col h-full">
        <Channel>
          <Window>
            <CustomChannelHeader />
            <MessageListComponent {...messageListProps} />
            <MessageInput focus />
          </Window>
          <Thread />
        </Channel>
      </div>
    </StreamChatErrorBoundary>
  );
};
