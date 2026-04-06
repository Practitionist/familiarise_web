"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { DashboardHeader } from "@/components/dashboard/DashboardShell";

interface ChatsTabProps {
  userId: string;
  userRole: string | null;
}

export function ChatsTab({ userId: _userId }: Readonly<ChatsTabProps>) {
  return (
    <>
      <DashboardHeader title="Chats" subtitle="Messages and conversations" />
      <div
        className="mt-4 w-full bg-white rounded-lg border border-zinc-200 shadow-sm overflow-hidden"
        style={{ height: "calc(100vh - 220px)", minHeight: "400px" }}
      >
        <ChatLayout />
      </div>
    </>
  );
}
