"use client";

import { Loader2 } from "lucide-react";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useStreamConnection } from "@/providers/StreamProvider";

interface ChatsTabProps {
  userId: string;
  userRole: string | null;
}

export function ChatsTab({ userId: _userId }: Readonly<ChatsTabProps>) {
  // Connection state from the lazy Stream provider: render the chat UI only
  // once the chat client is live; surface failures instead of a blank box.
  const { chatConnected, error, retryConnection } = useStreamConnection();

  return (
    <>
      <DashboardHeader title="Chats" subtitle="Messages and conversations" />
      <div className="mt-4 w-full bg-card rounded-xl border border-border shadow-sm overflow-hidden h-[calc(100vh-15rem)] min-h-[400px]">
        {error ? (
          <ChatUnavailable description={error} onRetry={retryConnection} />
        ) : chatConnected ? (
          <ChatLayout />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />
            Connecting to chat…
          </div>
        )}
      </div>
    </>
  );
}
