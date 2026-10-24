"use client";

import { useEffect, useState } from "react";
import { reportSentryError } from "@/lib/observability/report";
import { StreamChat, type Channel } from "stream-chat";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

/**
 * Unread message count for the personal (B2C) inbox.
 *
 * The base number is Stream's own `total_unread_count` (`client.user` from the
 * connect response, then every `message.new` / `notification.*` event that
 * carries it), so it covers every channel the user is in, not just the page
 * `ChatSidebar` has loaded. That total is global, though, and includes org-tagged
 * channels: a consultant who is also an org EXPERT must not see their personal
 * badge light up for an org conversation, so the unread of org-tagged channels
 * is subtracted (ADR 19 — org unread belongs to the org dashboard's own entry).
 *
 * API budget: a recount is local while the total is fully explained by loaded
 * channels. Only when unread exists outside them does one throttled
 * `getUnreadCount` identify the per-channel unread, and one `queryChannels` per
 * 30 newly seen cids classifies them; classifications are cached for the mount.
 *
 * Works outside StreamProvider — uses the StreamChat singleton directly.
 */
const FALLBACK_MIN_INTERVAL_MS = 30_000;
const CLASSIFY_PAGE_SIZE = 30;

function isPersonalChannel(channel: Channel): boolean {
  const data = channel.data as Record<string, unknown> | undefined;
  const orgId = data?.organization_id;
  return orgId === undefined || orgId === null;
}

/**
 * stream-chat keeps every hydrated channel keyed by cid on this runtime
 * property, but v9's typings don't declare it. One cast, one place, with the
 * pinned-major caveat noted. (v9 renamed the old `client.channels` map to
 * `activeChannels`.)
 */
function loadedChannels(client: StreamChat): Record<string, Channel> {
  return (
    (
      client as unknown as {
        activeChannels?: Record<string, Channel>;
      }
    ).activeChannels ?? {}
  );
}

export function useChatUnreadCount(): number {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!apiKey) return;

    const client = StreamChat.getInstance(apiKey);

    let cancelled = false;
    // Freshest total seen on an event; `client.user` is the fallback.
    let eventTotal: number | undefined;
    // cid -> true when the channel is org-tagged (resolved via queryChannels).
    const orgByCid = new Map<string, boolean>();
    // Org-tagged unread the last server reconcile found outside loaded channels.
    let unloadedOrg = new Map<string, number>();

    const serverTotal = (): number | undefined => {
      const user = client.user;
      const own =
        user && "total_unread_count" in user
          ? user.total_unread_count
          : undefined;
      return eventTotal ?? own;
    };

    // Unread held by loaded channels, split by org-ness. `initialized` guards
    // channels whose read state has not hydrated.
    const loadedUnread = () => {
      const loaded = loadedChannels(client);
      let personal = 0;
      let org = 0;
      for (const channel of Object.values(loaded)) {
        if (!channel.initialized) continue;
        const unread = channel.countUnread();
        if (isPersonalChannel(channel)) personal += unread;
        else org += unread;
      }
      for (const [cid, unread] of unloadedOrg) {
        if (!loaded[cid]?.initialized) org += unread;
      }
      return { personal, org };
    };

    let lastReconcileAt = 0;
    const reconcileViaServer = async () => {
      try {
        const counts = await client.getUnreadCount();
        const loaded = loadedChannels(client);
        const unknown = counts.channels
          .filter(
            (c) =>
              c.unread_count > 0 &&
              !loaded[c.channel_id]?.initialized &&
              !orgByCid.has(c.channel_id),
          )
          .map((c) => c.channel_id);
        for (let i = 0; i < unknown.length; i += CLASSIFY_PAGE_SIZE) {
          const cids = unknown.slice(i, i + CLASSIFY_PAGE_SIZE);
          const found = await client.queryChannels(
            { cid: { $in: cids } },
            {},
            { limit: CLASSIFY_PAGE_SIZE, state: true, watch: false },
          );
          for (const channel of found) {
            orgByCid.set(channel.cid, !isPersonalChannel(channel));
          }
        }
        if (cancelled) return;
        let orgUnread = 0;
        const nextUnloadedOrg = new Map<string, number>();
        for (const c of counts.channels) {
          const channel = loaded[c.channel_id];
          if (channel?.initialized) {
            if (!isPersonalChannel(channel)) orgUnread += c.unread_count;
          } else if (orgByCid.get(c.channel_id) === true) {
            orgUnread += c.unread_count;
            nextUnloadedOrg.set(c.channel_id, c.unread_count);
          }
        }
        unloadedOrg = nextUnloadedOrg;
        setUnreadCount(Math.max(0, counts.total_unread_count - orgUnread));
      } catch (error) {
        // A failed recount leaves the previous number in place — a stale badge
        // beats one that drops to zero on a transient error.
        reportSentryError(error, { subsystem: "client", expected: true });
      }
    };

    const refresh = () => {
      if (cancelled) return;
      const total = serverTotal();
      // Pre-connect: no identity or total yet; the connection.changed(online)
      // event retries.
      if (!client.userID || total === undefined) return;
      const { personal, org } = loadedUnread();
      setUnreadCount(Math.max(0, total - org));
      // Unread beyond what is explained so far may be org-tagged: ask the
      // server which, at most once per interval.
      if (total === personal + org) return;
      const now = Date.now();
      if (now - lastReconcileAt < FALLBACK_MIN_INTERVAL_MS) return;
      lastReconcileAt = now;
      void reconcileViaServer();
    };

    // Event bursts coalesce into ONE recount ~250ms after the last event.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, 250);
    };

    refresh();

    // connection.changed(online) — this hook often mounts before StreamProvider
    // finishes connecting, so the connect response arrives as a later event.
    const handler = client.on((event) => {
      if (event.type === "connection.changed") {
        if (event.online) {
          eventTotal = undefined;
          scheduleRefresh();
        }
        return;
      }
      if (
        event.type !== "message.new" &&
        event.type !== "notification.mark_read" &&
        event.type !== "notification.mark_unread" &&
        event.type !== "notification.message_new"
      ) {
        return;
      }
      if (typeof event.total_unread_count === "number") {
        eventTotal = event.total_unread_count;
      }
      scheduleRefresh();
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      handler.unsubscribe();
    };
  }, []);

  return unreadCount;
}
