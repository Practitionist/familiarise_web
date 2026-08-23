"use client";

import { useEffect, useState } from "react";
import { reportSentryError } from "@/lib/observability/report";
import { StreamChat, type Channel } from "stream-chat";

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
 * Works outside StreamProvider — uses the StreamChat singleton directly.
 *
 * API-budget design (2026-08-23): this hook used to re-run a full
 * `queryChannels` on EVERY message.new / mark_read event. Filtering on a
 * custom channel field (`organization_id`) is one of Stream's documented
 * expensive-query shapes, so a busy chat burned QueryChannels API budget and
 * added latency for a badge. Now:
 *   1. Recounts are LOCAL — summed in memory over channels already watched by
 *      `ChatSidebar` (same client singleton, `state: true`), debounced so a
 *      message burst costs one re-render, not one request.
 *   2. A bounded fallback query runs only when nothing is watched yet (chat
 *      tab never opened this session) and is throttled to once per 30s.
 */
const PERSONAL_FILTER = { organization_id: { $exists: false } };

function isPersonalChannel(channel: Channel): boolean {
  const data = channel.data as Record<string, unknown> | undefined;
  const orgId = data?.organization_id;
  return orgId === undefined || orgId === null;
}

/**
 * stream-chat keeps every hydrated channel keyed by cid on this runtime
 * property, but v9's typings don't declare it. One cast, one place, with the
 * pinned-major caveat noted: iterating it lets the badge recount from state
 * ChatSidebar already paid for, instead of re-querying Stream per event.
 */
function loadedChannels(client: StreamChat): Channel[] {
  return Object.values(
    (client as unknown as { channels: Record<string, Channel> }).channels ?? {},
  );
}

export function useChatUnreadCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!apiKey) return;

    const client = StreamChat.getInstance(apiKey);

    let cancelled = false;

    // Sum unread counts over this client's ALREADY-loaded personal channels.
    // Returns null when none are loaded (caller may fall back to a query).
    const recountLocal = (): number | null => {
      if (!client.userID) return null;
      let seen = 0;
      let total = 0;
      for (const channel of loadedChannels(client)) {
        if (!channel.initialized || !isPersonalChannel(channel)) continue;
        seen += 1;
        total += channel.countUnread();
      }
      return seen > 0 ? total : null;
    };

    // One bounded query when nothing is watched yet. Same filter as
    // ChatSidebar's `personal` arm, so badge and inbox can never disagree.
    let lastFallbackAt = 0;
    const FALLBACK_MIN_INTERVAL_MS = 30_000;
    const recountViaQuery = async () => {
      try {
        const channels = await client.queryChannels(
          { members: { $in: [client.userID!] }, ...PERSONAL_FILTER },
          { last_message_at: -1 },
          // state:true hydrates read state so countUnread() works; watch:false
          // because this hook only counts — ChatSidebar owns watching.
          { limit: 30, state: true, watch: false },
        );
        if (cancelled) return;
        setUnreadCount(channels.reduce((sum, c) => sum + c.countUnread(), 0));
      } catch (error) {
        // A failed recount leaves the previous number in place — a stale badge
        // beats one that drops to zero on a transient error. Reported for
        // visibility only; the degrade itself is unchanged.
        reportSentryError(error, { subsystem: "client", expected: true });
      }
    };

    // Event bursts coalesce into ONE recount ~250ms after the last event.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      if (cancelled) return;
      const local = recountLocal();
      if (local !== null) {
        setUnreadCount(local);
        return;
      }
      const now = Date.now();
      if (now - lastFallbackAt < FALLBACK_MIN_INTERVAL_MS) return;
      lastFallbackAt = now;
      void recountViaQuery();
    };

    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 250);
    };

    void refresh();

    // Recount signals:
    //   - connection.changed(online) → the singleton just connected (this hook
    //     often mounts before StreamProvider finishes connecting); retry the
    //     initial load instead of staying at zero until some unrelated remount.
    //   - message events → local recount (debounced), no API call when any
    //     personal channel is already watched.
    const handler = client.on((event) => {
      if (
        event.type === "message.new" ||
        event.type === "notification.mark_read" ||
        event.type === "notification.message_new" ||
        (event.type === "connection.changed" && event.online)
      ) {
        scheduleRefresh();
      }
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      handler.unsubscribe();
    };
  }, []);

  return unreadCount;
}
