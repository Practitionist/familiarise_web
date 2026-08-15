"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { useChatPane } from "./ChatPaneContext";
import { useChatContext } from "stream-chat-react";
import { SearchIcon, UserIcon, VideoIcon, BookOpenIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AppointmentSearchResult } from "@/schemas/stream-search";

// Type badge configuration for events (webinars/classes)
const EVENT_TYPE_CONFIG = {
  webinar: {
    label: "Webinar",
    icon: VideoIcon,
  },
  class: {
    label: "Class",
    icon: BookOpenIcon,
  },
} as const;

/**
 * One row per conversation: a consultation and a subscription with the same
 * person collapse into a single entry, because they are a single channel.
 * A pair has one DM thread per funding context (#1134 P0-7), so the badges
 * "Consultation & Subscription" describe two reasons to be in one thread, not
 * two threads.
 */
type GroupedConversation = {
  counterpartyName: string;
  counterpartyImage?: string;
  counterpartyUserId?: string;
  organizationId?: string | null;
  hasConsultation: boolean;
  hasSubscription: boolean;
  channelId: string;
};

export const ChannelSearch = () => {
  const { client, setActiveChannel } = useChatContext();
  // Below `md` the conversation pane is `hidden` until this runs — see
  // ChatLayout. Selecting a channel without it leaves the person staring at
  // the list they just searched, with the channel silently active behind it.
  const { openConversation } = useChatPane();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AppointmentSearchResult[]>(
    [],
  );

  // Group 1:1 rows by CHANNEL, keep events separate.
  //
  // Keyed on `channelId`, not on the display name. Grouping by name merged two
  // different people who happen to share one — and, more often here, split a
  // single conversation in two whenever the name resolved differently between
  // rows. The channel id is the identity of a conversation; the name is a label
  // on it.
  const { groupedConversations, events } = useMemo(() => {
    const byChannel = new Map<string, GroupedConversation>();
    const eventResults: AppointmentSearchResult[] = [];

    // Defensive check in case searchResults is undefined
    if (!searchResults || !Array.isArray(searchResults)) {
      return { groupedConversations: [], events: [] };
    }

    for (const result of searchResults) {
      if (result.type === "consultation" || result.type === "subscription") {
        const existing = byChannel.get(result.channelId);
        if (existing) {
          if (result.type === "consultation") existing.hasConsultation = true;
          if (result.type === "subscription") existing.hasSubscription = true;
        } else {
          byChannel.set(result.channelId, {
            counterpartyName: result.counterpartyName,
            counterpartyImage: result.counterpartyImage,
            counterpartyUserId: result.counterpartyUserId,
            organizationId: result.organizationId,
            hasConsultation: result.type === "consultation",
            hasSubscription: result.type === "subscription",
            channelId: result.channelId,
          });
        }
      } else {
        // Webinars and classes shown individually
        eventResults.push(result);
      }
    }

    return {
      groupedConversations: Array.from(byChannel.values()),
      events: eventResults,
    };
  }, [searchResults]);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(
        `/api/stream/channels/search-appointments?q=${encodeURIComponent(query.trim())}`,
      );

      if (!response.ok) {
        throw new Error("Failed to search appointments");
      }

      const results: AppointmentSearchResult[] = await response.json();
      setSearchResults(results);
    } catch (error) {
      console.error("Error searching appointments:", error);
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Debounced search effect
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    const timeoutId = setTimeout(() => {
      handleSearch();
    }, 300); // 300ms delay

    return () => clearTimeout(timeoutId);
  }, [query, handleSearch]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSearch();
  };

  /**
   * Ask the SERVER for the channel, then watch what it hands back.
   *
   * The previous implementation called `client.channel(type, id).watch()` on an
   * id this component had received from search. `watch()` posts to Stream's
   * channel *query* endpoint, which is the same endpoint `create()` posts to —
   * so when the id did not exist yet, watching it CREATED it, with this user as
   * `created_by` and with no members at all. The result was a channel titled
   * with its own raw id, reporting "No members", that accepted a message and
   * then disappeared on refresh (the sidebar lists `members: { $in: [me] }`).
   *
   * So the client no longer names a channel. It names a person or an event, and
   * `/api/stream/channels/open` re-derives the id, checks the booking link, and
   * creates the channel with both members if it is genuinely missing. By the
   * time `watch()` runs here, the channel is known to exist.
   */
  const openResolvedChannel = async (
    body: Record<string, unknown>,
  ): Promise<void> => {
    if (!client) return;

    try {
      const response = await fetch("/api/stream/channels/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        // 403 is the eligibility gate refusing, which is a legitimate answer,
        // not a fault. Surfacing it as an error toast would be wrong; the row
        // should not have been offered in the first place.
        console.error(
          "Could not open conversation:",
          detail?.error ?? response.status,
        );
        return;
      }

      const { channelType, channelId } = (await response.json()) as {
        channelType: "messaging" | "team";
        channelId: string;
      };

      const channel = client.channel(channelType, channelId);
      await channel.watch();
      setActiveChannel(channel);
      openConversation();
    } catch (error) {
      console.error("Error opening channel:", error);
    }

    // Clear search
    setQuery("");
    setSearchResults([]);
  };

  const handleConversationClick = (conversation: GroupedConversation) =>
    openResolvedChannel({
      kind: "dm",
      counterpartyUserId: conversation.counterpartyUserId,
      organizationId: conversation.organizationId ?? null,
    });

  const handleEventClick = (result: AppointmentSearchResult) =>
    openResolvedChannel({
      kind: "event",
      eventType: result.type,
      eventId: result.id,
    });

  const hasResults = groupedConversations.length > 0 || events.length > 0;

  return (
    <div className="channel-search relative">
      <form onSubmit={handleSearchSubmit} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full text-sm normal-case"
        />
      </form>

      {hasResults && (
        <div className="absolute z-50 mt-1 w-full bg-popover text-popover-foreground rounded-md shadow-xl border border-border max-h-72 overflow-auto">
          {/* Conversations Section (Consultants with consultations/subscriptions) */}
          {groupedConversations.length > 0 && (
            <>
              <div className="px-3 py-2 bg-muted border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Conversations
                </span>
              </div>
              {groupedConversations.map((conversation) => (
                <button
                  key={conversation.channelId}
                  className="p-3 hover:bg-muted cursor-pointer w-full text-left border-b border-border last:border-b-0"
                  onClick={() => handleConversationClick(conversation)}
                >
                  <div className="flex items-center gap-3">
                    {/* Consultant Image */}
                    {conversation.counterpartyImage ? (
                      <Image
                        src={conversation.counterpartyImage}
                        alt={conversation.counterpartyName}
                        width={40}
                        height={40}
                        className="w-10 h-10 rounded-full flex-shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                        <span className="text-muted-foreground font-medium">
                          {conversation.counterpartyName.charAt(0)}
                        </span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      {/* Consultant Name */}
                      <div className="font-semibold text-foreground truncate">
                        {conversation.counterpartyName}
                      </div>

                      {/* Type indicators */}
                      <div className="flex items-center gap-1 mt-1">
                        <UserIcon className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {conversation.hasConsultation &&
                          conversation.hasSubscription
                            ? "Consultation & Subscription"
                            : conversation.hasConsultation
                              ? "Consultation"
                              : "Subscription"}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* Events Section (Webinars/Classes) */}
          {events.length > 0 && (
            <>
              <div className="px-3 py-2 bg-muted border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Events
                </span>
              </div>
              {events.map((event) => {
                const config =
                  EVENT_TYPE_CONFIG[event.type as "webinar" | "class"];
                const Icon = config.icon;

                return (
                  <button
                    key={`${event.type}-${event.id}`}
                    className="p-3 hover:bg-muted cursor-pointer w-full text-left border-b border-border last:border-b-0"
                    onClick={() => handleEventClick(event)}
                  >
                    <div className="flex items-start gap-3">
                      {/* Consultant Image */}
                      {event.counterpartyImage ? (
                        <Image
                          src={event.counterpartyImage}
                          alt={event.counterpartyName}
                          width={40}
                          height={40}
                          className="w-10 h-10 rounded-full flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                          <span className="text-muted-foreground font-medium">
                            {event.counterpartyName.charAt(0)}
                          </span>
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        {/* Event Name */}
                        <div className="font-semibold text-foreground truncate">
                          {event.name}
                        </div>

                        {/* Type Badge + Consultant Name */}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs font-medium">
                            <Icon className="w-3 h-3" />
                            {config.label}
                          </span>
                          <span className="text-sm text-muted-foreground truncate">
                            {event.counterpartyName}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* No results message */}
      {query.trim().length >= 2 && !loading && !hasResults && (
        <div className="absolute z-50 mt-1 w-full bg-popover text-muted-foreground rounded-md shadow-xl border border-border p-4 text-center text-sm">
          No results found for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
};
