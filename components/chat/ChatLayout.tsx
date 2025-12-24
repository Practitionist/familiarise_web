"use client";

import { ChatSidebar } from "./ChatSidebar";
import { ChatContainer } from "./ChatContainer";

export const ChatLayout = () => {
  return (
    <div className="flex h-full w-full min-h-0">
      <ChatSidebar />
      <div className="flex-1 flex flex-col min-h-0 h-full">
        <ChatContainer />
      </div>
    </div>
  );
};
