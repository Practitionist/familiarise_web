"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";

interface ChatsTabProps {
  userId: string;
  userRole: string | null;
}

export function ChatsTab({ userId }: Readonly<ChatsTabProps>) {
  return (
    <div className="h-full w-full bg-white rounded-lg shadow-lg overflow-hidden">
      <ChatLayout />
    </div>
  );
}
