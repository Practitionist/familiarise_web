"use client";

import type { ReactNode } from "react";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { ChatUnavailable } from "@/components/chat/ChatUnavailable";
import { ChatSkeletonPanes } from "@/components/dashboard/DashboardSkeletons";
import { StreamChatScope } from "@/components/stream/StreamChatScope";
import { useStreamConnection } from "@/providers/StreamProvider";

/**
 * The chat surface shared by the Messages pages and the appointment chat sheet:
 * failure first, then the live layout (or `children`), else the loading state.
 *
 * The layout stays mounted while the SDK reconnects a dropped socket, so a
 * Wi-Fi blip keeps the draft, scroll position and active channel; only a
 * non-blocking banner appears.
 */
export function ChatSurface({
  children,
  loading,
}: Readonly<{ children?: ReactNode; loading?: ReactNode }>) {
  const { chatConnected, chatReconnecting, failure, retryConnection } =
    useStreamConnection();

  if (failure) {
    return <ChatUnavailable failure={failure} onRetry={retryConnection} />;
  }

  if (!chatConnected && !chatReconnecting) {
    return loading ?? <ChatSkeletonPanes />;
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
      <StreamChatScope>{children ?? <ChatLayout />}</StreamChatScope>
    </div>
  );
}
