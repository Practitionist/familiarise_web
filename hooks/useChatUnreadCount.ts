"use client";

import { useEffect, useState } from "react";
import { StreamChat } from "stream-chat";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

/**
 * Unread message count for the personal (B2C) inbox.
 *
 * Deliberately NOT Stream's `total_unread_count`, which this hook used to
 * return. That number is global across every channel the user belongs to,
 * including org-tagged ones — so a consultant who is also an org EXPERT saw
 * their personal sidebar badge light up for an org conversation, clicked
 * through, and found nothing: `ChatSidebar` filters the personal inbox to
 * `organization_id: { $exists: false }`. The badge has to use the same
 * predicate as the list it points at, or it is lying about where the message is.
 *
 * Org unread counts belong to the org dashboard's own Messages entry (ADR 19 —
 * split by the org-ness of the underlying work).
 *
 * Works outside StreamProvider — uses the StreamChat singleton directly. The
 * singleton is created by StreamProvider on layout mount, so the count becomes
 * available once the chat client connects.
 */
export function useChatUnreadCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!apiKey) return;

    const client = StreamChat.getInstance(apiKey);
    const userId = client.userID;
    if (!userId) return; // Not connected yet

    let cancelled = false;

    // Same filter as ChatSidebar's `personal` arm, so the badge and the inbox
    // can never disagree about which channels count.
    const recount = async () => {
      try {
        // `organization_id` is a custom channel field, which ChannelFilters
        // doesn't declare — spread it in the same way ChatSidebar does rather
        // than asserting the whole filter.
        const orgFilter: Record<string, unknown> = {
          organization_id: { $exists: false },
        };
        const channels = await client.queryChannels(
          { members: { $in: [userId] }, ...orgFilter },
          { last_message_at: -1 },
          { limit: 30, state: true },
        );
        if (cancelled) return;
        setUnreadCount(
          channels.reduce((sum, channel) => sum + channel.countUnread(), 0),
        );
      } catch {
        // A failed recount leaves the previous number in place — a stale badge
        // beats one that drops to zero on a transient error.
      }
    };

    void recount();

    // Stream emits these alongside a global total_unread_count. We ignore the
    // value and use the event purely as a signal to recount within our scope.
    const handler = client.on((event) => {
      if (
        event.type === "message.new" ||
        event.type === "notification.mark_read" ||
        event.type === "notification.message_new"
      ) {
        void recount();
      }
    });

    return () => {
      cancelled = true;
      handler.unsubscribe();
    };
  }, []);

  return unreadCount;
}
