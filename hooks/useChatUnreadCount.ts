"use client";

import { useEffect, useState } from "react";
import { StreamChat } from "stream-chat";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

/**
 * Subscribes to total unread message count from Stream Chat.
 * Works outside StreamProvider — uses the StreamChat singleton directly.
 * The singleton is created by StreamProvider on layout mount, so the count
 * becomes available once the chat client connects.
 */
export function useChatUnreadCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!apiKey) return;

    const client = StreamChat.getInstance(apiKey);
    if (!client.userID) return; // Not connected yet

    // Get initial count — total_unread_count exists on OwnUserResponse but not on the union type
    const user = client.user as Record<string, unknown> | undefined;
    const total = user?.total_unread_count;
    if (typeof total === "number") setUnreadCount(total);

    // Subscribe to count changes via Stream events
    const handler = client.on((event) => {
      if (typeof event.total_unread_count === "number") {
        setUnreadCount(event.total_unread_count);
      }
    });

    return () => handler.unsubscribe();
  }, []);

  return unreadCount;
}
