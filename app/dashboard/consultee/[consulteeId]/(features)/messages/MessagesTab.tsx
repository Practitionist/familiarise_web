"use client";

import { Loader2 } from "lucide-react";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { useStreamConnection } from "@/providers/StreamProvider";

export default function MessagesTab() {
  // Connection state from the Stream provider: render the chat UI only once
  // the chat client is live; surface failures instead of a blank box (same
  // contract as the consultant Chats tab).
  const { chatConnected, error, retryConnection } = useStreamConnection();

  return (
    <div className="w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm h-[calc(100dvh-8rem)] min-h-[min(280px,calc(100dvh-8rem))] max-h-[calc(100dvh-6rem)] sm:h-[calc(100dvh-9rem)] sm:min-h-[min(360px,calc(100dvh-9rem))]">
      {error ? (
        <ChatUnavailable description={error} onRetry={retryConnection} />
      ) : chatConnected ? (
        <ChatLayout />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-6 w-6 animate-spin" />
          Connecting to chat…
        </div>
      )}
    </div>
  );
}
