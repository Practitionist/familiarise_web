"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import {
  getStreamConnectionServerSnapshot,
  getStreamConnectionSnapshot,
  subscribeStreamConnection,
} from "@/lib/stream/connection-store";

/**
 * Mounts the Stream `<Chat>` context around a chat surface.
 *
 * This used to wrap the WHOLE dashboard from StreamProvider, which cost two
 * things: `ssr: false` on that wrapper meant no dashboard markup was ever
 * server-rendered, and the wrapper appearing once the socket settled changed
 * the element type at that position and remounted everything under it (#248).
 *
 * Scoping it here is safe because every `useChatContext` consumer lives under
 * `components/chat/`. The sidebar's unread badge is deliberately NOT one of
 * them — `hooks/useChatUnreadCount` reads the `StreamChat` singleton directly
 * and documents that it works outside the provider.
 *
 * Renders children unwrapped until the client connects; chat consumers already
 * guard a null client, and this keeps the surface visible while connecting.
 */
const ChatProvider = dynamic(
  () => import("stream-chat-react").then((m) => ({ default: m.Chat })),
  { ssr: false },
);

export function StreamChatScope({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { clients } = useSyncExternalStore(
    subscribeStreamConnection,
    getStreamConnectionSnapshot,
    getStreamConnectionServerSnapshot,
  );

  if (!clients?.chat) return <>{children}</>;
  return <ChatProvider client={clients.chat}>{children}</ChatProvider>;
}
