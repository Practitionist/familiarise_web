"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";

interface ChatsTabProps {
  userId: string;
  userRole: string | null;
}

export function ChatsTab({ userId }: Readonly<ChatsTabProps>) {
  return (
    <div className="flex-1 flex flex-col w-full bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden m-4 lg:m-6">
      <ChatLayout />
    </div>
  );
}
