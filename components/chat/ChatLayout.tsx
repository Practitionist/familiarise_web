"use client";

import { ChatSidebar } from "./ChatSidebar";
import { ChatContainer } from "./ChatContainer";

export const ChatLayout = () => {
  return (
    <div className="flex h-full w-full">
      <ChatSidebar />
      <div className="flex-1 flex flex-col h-full">
        <ChatContainer />
      </div>
    </div>
  );
};
