"use client";

import { ChatLayout } from "@/components/chat/ChatLayout";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { ChatSkeletonPanes } from "@/components/dashboard/DashboardSkeletons";
import { StreamChatScope } from "@/components/stream/StreamChatScope";
import { useStreamConnection } from "@/providers/StreamProvider";

/**
 * The chat surface shared by the consultant, consultee and organisation
 * Messages pages: failure first, then the live layout, else the skeleton.
 *
 * The layout stays mounted while the SDK reconnects a dropped socket, so a
 * Wi-Fi blip keeps the draft, scroll position and active channel; only a
 * non-blocking banner appears.
 */
export function ChatSurface() {
  const { chatConnected, chatReconnecting, failure, retryConnection } =
    useStreamConnection();

  if (failure) {
    return <ChatUnavailable failure={failure} onRetry={retryConnection} />;
  }

  if (!chatConnected && !chatReconnecting) {
    return <ChatSkeletonPanes />;
  }

  return (
    <div className="relative h-full">
      {!chatConnected && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
        >
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground shadow">
            Reconnecting…
          </span>
        </div>
      )}
      <StreamChatScope>
        <ChatLayout />
      </StreamChatScope>
    </div>
  );
}
