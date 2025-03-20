"use client";

import {
  Channel,
  ChannelHeader,
  MessageInput,
  MessageList,
  Thread,
  Window,
} from "stream-chat-react";
import { CustomMessage } from "./CustomMessage";

export const ChatContainer = () => {
  return (
    <div className="flex-1 flex flex-col h-full">
      <Channel>
        <Window>
          <ChannelHeader />
          <MessageList Message={CustomMessage} />
          <MessageInput focus />
        </Window>
        <Thread />
      </Channel>
    </div>
  );
};
