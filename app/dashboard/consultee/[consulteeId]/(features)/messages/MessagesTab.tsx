"use client";

import { Loader2 } from "lucide-react";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { useStreamConnection } from "@/providers/StreamProvider";

/**
 * Full-bleed chat surface: cancels PageScaffold padding and fills the
 * content column under the context bar (and above the mobile tab bar).
 */
export default function MessagesTab() {
  // Connection state from the Stream provider: render the chat UI only once
  // the chat client is live; surface failures instead of a blank box (same
  // contract as the consultant Chats tab).
  const { chatConnected, error, retryConnection } = useStreamConnection();

  return (
    <div className="-m-4 h-[calc(100dvh-3.5rem-4rem)] overflow-hidden border-border bg-card sm:-m-6 md:h-[calc(100dvh-3.5rem)] lg:-m-8">
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
