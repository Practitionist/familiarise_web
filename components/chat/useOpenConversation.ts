"use client";

import { useCallback, useState } from "react";
import type { Channel } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { useChatPane } from "./ChatPaneContext";

/**
 * What `/api/stream/channels/open` accepts.
 *
 * A discriminated union rather than `Record<string, unknown>`: the route parses
 * this with a zod discriminated union, and typing the client side as an open
 * bag meant a wrong `eventType` — `"consultation"` reaching the event arm, say —
 * failed at runtime with a 400 instead of at compile time. The route is the
 * authority on the shape; this mirrors it.
 */
export type OpenChannelRequest =
  | { kind: "dm"; counterpartyUserId: string; organizationId: string | null }
  | { kind: "event"; eventType: "webinar" | "class"; eventId: string };

/**
 * Ask the SERVER for the channel, then watch what it hands back. Search and the
 * New message picker both open a conversation this way.
 *
 * The client never names a channel. `client.channel(type, id).watch()` posts to
 * Stream's channel *query* endpoint, the same one `create()` uses, so watching an
 * id that did not exist CREATED it with no members: a channel titled with its own
 * raw id, reporting "No members", that accepted a message and then disappeared on
 * refresh. So the client names a person or an event, and
 * `/api/stream/channels/open` re-derives the id, checks the booking link and
 * brings the caller (and the history) back into the thread. By the time `watch()`
 * runs here the channel is known to exist.
 *
 * Resolves true once the conversation is active. On a refusal it resolves false
 * and `openError` says why. A 403 is the eligibility gate answering, which is a
 * legitimate answer rather than a fault, but it still has to be SAID.
 */
export function useOpenConversation({
  onOpened,
}: {
  /** Called with the opened channel so the caller can list it. */
  onOpened?: (channel: Channel) => void;
} = {}) {
  const { client, setActiveChannel } = useChatContext();
  // Below `md` the conversation pane is `hidden` until this runs (see ChatLayout);
  // without it the channel is active behind the list the person just used.
  const { openConversation } = useChatPane();
  const [openError, setOpenError] = useState<string | null>(null);

  const open = useCallback(
    async (body: OpenChannelRequest): Promise<boolean> => {
      if (!client) return false;
      setOpenError(null);

      try {
        const response = await fetch("/api/stream/channels/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setOpenError(
            detail?.error ??
              "Could not open this conversation. Please try again.",
          );
          return false;
        }

        const { channelType, channelId } = (await response.json()) as {
          channelType: "messaging" | "team";
          channelId: string;
        };

        const channel = client.channel(channelType, channelId);
        await channel.watch();
        setActiveChannel(channel);
        openConversation();
        onOpened?.(channel);
        return true;
      } catch (error) {
        console.error("Error opening channel:", error);
        setOpenError("Could not open this conversation. Please try again.");
        return false;
      }
    },
    [client, setActiveChannel, openConversation, onOpened],
  );

  return { open, openError, setOpenError };
}
