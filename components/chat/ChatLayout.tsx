"use client";

import { ChatSidebar } from "./ChatSidebar";
import { ChatContainer } from "./ChatContainer";

export const ChatLayout = () => {
  return (
    <div className="flex h-full w-full">
      <ChatSidebar />
      <ChatContainer />
    </div>
  );
};
