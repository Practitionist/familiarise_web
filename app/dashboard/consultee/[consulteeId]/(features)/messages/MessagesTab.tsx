"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";

export default function MessagesTab() {
  return (
    <div className="w-full bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden" style={{ height: 'calc(100vh - 140px)' }}>
      <ChatLayout />
    </div>
  );
}
