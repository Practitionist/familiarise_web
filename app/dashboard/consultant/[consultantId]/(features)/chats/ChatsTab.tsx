"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";

interface ChatsTabProps {
  userId: string;
  userRole: string | null;
}

export function ChatsTab({ userId }: Readonly<ChatsTabProps>) {
  return (
    <div
      className="w-full bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden"
      style={{ height: "calc(100vh - 100px)" }}
    >
      <ChatLayout />
    </div>
  );
}
