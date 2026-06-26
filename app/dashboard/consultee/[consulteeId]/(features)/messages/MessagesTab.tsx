"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";

export default function MessagesTab() {
  return (
    <div
      className="w-full bg-card rounded-xl border border-border shadow-sm overflow-hidden"
      style={{ height: "calc(100vh - 100px)" }}
    >
      <ChatLayout />
    </div>
  );
}
