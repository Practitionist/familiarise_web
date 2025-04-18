"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Channel,
  MessageInput,
  MessageList,
  Thread,
  Window,
  useChatContext,
} from "stream-chat-react";
import { CustomChannelHeader } from "./CustomChannelHeader";
import { CustomMessage } from "./CustomMessage";

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

  useEffect(() => {
    setHasChannel(!!channel);
  }, [channel]);

  if (!hasChannel) {
    return <EmptyChannelState />;
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <Channel>
        <Window>
          <CustomChannelHeader />
          <MessageList Message={CustomMessage} />
          <MessageInput focus />
        </Window>
        <Thread />
      </Channel>
    </div>
  );
};
