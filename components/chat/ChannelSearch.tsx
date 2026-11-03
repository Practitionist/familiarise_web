"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";
import Image from "next/image";
import type { Channel } from "stream-chat";
import { SearchIcon, VideoIcon, BookOpenIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { scopeOrgId, type Scope } from "@/lib/api/scope/parse";
import type { AppointmentSearchResult } from "@/schemas/stream-search";
import {
  ConversationResultRow,
  formatSessionTime,
  mergeConversationRow,
  type GroupedConversation,
} from "./ConversationResult";
import {
  useOpenConversation,
  type OpenChannelRequest,
} from "./useOpenConversation";
import { MIN_SEARCH_LENGTH } from "./utils/channelUtils";

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

/** A search hit for a group event. Narrower than AppointmentSearchResult. */
type EventSearchResult = AppointmentSearchResult & {
  type: "webinar" | "class";
};

const isEventResult = (r: AppointmentSearchResult): r is EventSearchResult =>
  r.type === "webinar" || r.type === "class";

const DEFAULT_PERSONAL_SCOPE: Scope = { kind: "personal" };

/**
 * The search box over the sidebar.
 *
 * Typing filters the already-loaded chats instantly (the parent does that, fed by
 * `onTermChange`). The server search below finds what the list does not hold:
 * unloaded conversations, plan titles, people by email, sessions by date. Rows
 * whose channel is in `listedChannelIds` are the list's own matches and are left
 * out of the dropdown.
 */
export const ChannelSearch = ({
  scope = DEFAULT_PERSONAL_SCOPE,
  onTermChange,
  listedChannelIds,
  onOpened,
}: {
  scope?: Scope;
  onTermChange?: (term: string) => void;
  listedChannelIds?: ReadonlySet<string>;
  /** Called with a conversation opened from a result, so the sidebar can list it. */
  onOpened?: (channel: Channel) => void;
} = {}) => {
  const {
    open: openConversation,
    openError,
    setOpenError,
  } = useOpenConversation({ onOpened });
  const pinnedOrgId = scopeOrgId(scope);
  const scopeParam = pinnedOrgId ? `org:${pinnedOrgId}` : "personal";
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AppointmentSearchResult[]>(
    [],
  );
  /**
   * The query `searchResults` actually answers.
   *
   * Without this there is no way to distinguish "searched and found nothing"
   * from "have not searched yet", and the empty state rendered during the
   * 300ms debounce gap — announcing "No results found for michael" before a
   * request had been issued, on every keystroke, while the matching person sat
   * in the list underneath.
   */
  const [settledQuery, setSettledQuery] = useState("");
  /**
   * A search that FAILED, as distinct from one that found nothing.
   *
   * The catch used to set `settledQuery` and leave the results empty, which is
   * indistinguishable from a successful empty search — so a 500 or a dropped
   * connection rendered as "No results found for michael". That is the most
   * misleading thing it could say: it tells you the person does not exist.
   */
  const [searchError, setSearchError] = useState<string | null>(null);
  /** The dropdown is closed by an outside click while the term (and the list filter) stays. */
  const [dropdownDismissed, setDropdownDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * Latest-wins guard, mirroring `hooks/scheduling/useCalendarData.ts`.
   *
   * The AbortController below stops the NETWORK work, but a response that has
   * already been parsed is past the point of cancellation and still queued for
   * React's state pipeline. Only the response matching the most recently issued
   * request may commit — checked before every setState, including the one that
   * clears `loading`, because a stale reply's `finally` otherwise turns the
   * spinner off while a newer request is still in flight.
   */
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Group 1:1 rows by CHANNEL, keep events separate.
  //
  // Keyed on `channelId`, not on the display name. Grouping by name merged two
  // different people who happen to share one — and, more often here, split a
  // single conversation in two whenever the name resolved differently between
  // rows. The channel id is the identity of a conversation; the name is a label
  // on it.
  const { groupedConversations, events } = useMemo(() => {
    const byChannel = new Map<string, GroupedConversation>();
    const eventResults: EventSearchResult[] = [];

    // Defensive check in case searchResults is undefined
    if (!searchResults || !Array.isArray(searchResults)) {
      return { groupedConversations: [], events: [] };
    }

    for (const result of searchResults) {
      if (listedChannelIds?.has(result.channelId)) continue;
      if (isEventResult(result)) {
        eventResults.push(result);
      } else {
        mergeConversationRow(byChannel, result);
      }
    }

    return {
      groupedConversations: Array.from(byChannel.values()),
      events: eventResults,
    };
  }, [searchResults, listedChannelIds]);

  const runSearch = useCallback(
    async (raw: string) => {
      const term = raw.trim();

      // Abort whatever is still in flight. Nobody is waiting on it, and on a
      // route that fires every 300ms of typing the abandoned work is real server
      // cost, not just a wasted response.
      abortRef.current?.abort();

      if (term.length < MIN_SEARCH_LENGTH) {
        abortRef.current = null;
        setSearchResults([]);
        setSettledQuery("");
        setSearchError(null);
        setLoading(false);
        // Cleared here too. `handleSearch` used to early-return BEFORE the
        // setOpenError below, so a 403 refusal outlived the input that produced
        // it: emptying the box left an error panel floating over a blank search,
        // and `isOpen` kept the dropdown up with no way to dismiss it.
        setOpenError(null);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      // Bumped synchronously, before the first await, so two searches started in
      // the same tick still get distinct ids.
      const requestId = ++requestIdRef.current;

      try {
        setLoading(true);
        // A refusal from the previous attempt must not outlive the query that
        // caused it.
        setOpenError(null);
        setSearchError(null);

        // The viewer's zone decides which calendar day "3 nov" or "today" means.
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const response = await fetch(
          `/api/stream/channels/search-appointments?q=${encodeURIComponent(term)}&scope=${encodeURIComponent(scopeParam)}&tz=${encodeURIComponent(zone)}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error("Failed to search appointments");
        }

        const results: AppointmentSearchResult[] = await response.json();

        if (requestId !== requestIdRef.current) return;
        setSearchResults(results);
        setSettledQuery(term);
      } catch (error) {
        // An abort is this component cancelling its own request, not a failure.
        // Treating it as one would clear the results the newer request is about
        // to populate.
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (requestId !== requestIdRef.current) return;
        console.error("Error searching appointments:", error);
        setSearchResults([]);
        setSettledQuery(term);
        setSearchError("Search is unavailable right now. Please try again.");
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [scopeParam, setOpenError],
  );

  // 300ms, matching the five other search inputs in the app, and now via the
  // same `use-debounce` helper they use rather than a hand-rolled setTimeout.
  // The delay was never what felt slow — the empty-state flash inside it was.
  const debouncedSearch = useDebouncedCallback(runSearch, 300);

  useEffect(() => {
    debouncedSearch(query);
  }, [query, debouncedSearch]);

  // Abort anything outstanding when the component goes away, so a resolved
  // fetch cannot setState on an unmounted tree.
  useEffect(
    () => () => {
      // `use-debounce` v10 does NOT auto-cancel on unmount, so a trailing
      // callback can fire after the component is gone and start a search
      // nobody is waiting for. Abort covers a request already issued; cancel
      // covers one still sitting in the timer.
      debouncedSearch.cancel();
      abortRef.current?.abort();
    },
    [debouncedSearch],
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Submit means "now", so skip the pending debounce rather than adding a
    // second in-flight request alongside it.
    debouncedSearch.flush();
  };

  useEffect(() => {
    onTermChange?.(query);
  }, [query, onTermChange]);

  /**
   * Escape and the clear button empty the search; an outside click only closes the
   * dropdown.
   *
   * The term also filters the sidebar list, so clearing it on `pointerdown` would
   * re-expand that list under the pointer before the click lands, and the tap
   * would hit a different row than the one aimed at. `pointerdown`, not `click`:
   * a `click` listener fires after focus moves, which on touch closed the panel
   * before the tap that opened a row could land.
   */
  const dismiss = useCallback(() => {
    // Clear the TERM too, not just the rows: `isOpen`/`showNoResults` derive
    // from the settled query, so leaving it set turned dismiss into "replace
    // the results with No results found".
    setQuery("");
    setSettledQuery("");
    setSearchResults([]);
    setOpenError(null);
    setSearchError(null);
  }, [setOpenError]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setDropdownDismissed(true);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dismiss]);

  // Cleared only once the conversation is open. On a refusal the query is kept so
  // the message has something to sit under and the person can pick another row.
  const openResolvedChannel = async (body: OpenChannelRequest) => {
    if (await openConversation(body)) {
      setQuery("");
      setSearchResults([]);
    }
  };

  const handleConversationClick = (conversation: GroupedConversation) => {
    // Group-event rows carry no counterparty, and a malformed payload would be
    // rejected by the route's zod schema as a 400 — a worse message than this
    // one. Guard rather than round-trip.
    if (!conversation.counterpartyUserId) {
      setOpenError("This conversation is missing its participant.");
      return;
    }
    void openResolvedChannel({
      kind: "dm",
      counterpartyUserId: conversation.counterpartyUserId,
      organizationId: conversation.organizationId ?? null,
    });
  };

  const handleEventClick = (result: EventSearchResult) =>
    void openResolvedChannel({
      kind: "event",
      eventType: result.type,
      eventId: result.id,
    });

  const hasResults = groupedConversations.length > 0 || events.length > 0;
  const term = query.trim();
  /**
   * True from the keystroke until a response for THIS query has committed —
   * covering the debounce wait, which `loading` does not, because `loading`
   * only goes true once the fetch actually starts 300ms later.
   */
  const isPending =
    term.length >= MIN_SEARCH_LENGTH && (loading || settledQuery !== term);
  // The list below already shows its own matches, so "no results" would contradict it.
  const listHasMatches = (listedChannelIds?.size ?? 0) > 0;
  const showNoResults =
    term.length >= MIN_SEARCH_LENGTH &&
    !isPending &&
    !hasResults &&
    !listHasMatches &&
    searchError === null;
  const isOpen =
    !dropdownDismissed &&
    (hasResults || openError !== null || searchError !== null || showNoResults);

  return (
    <div className="channel-search relative" ref={containerRef}>
      <form onSubmit={handleSearchSubmit} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search people, plans, dates"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDropdownDismissed(false);
          }}
          onFocus={() => setDropdownDismissed(false)}
          className="pl-9 pr-9 w-full text-sm normal-case"
        />
        {query !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={dismiss}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="w-4 h-4" />
          </button>
        )}
      </form>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-popover text-popover-foreground rounded-md shadow-xl border border-border max-h-72 overflow-auto">
          {openError && (
            <div
              role="status"
              className="px-3 py-2 text-sm text-muted-foreground border-b border-border last:border-b-0"
            >
              {openError}
            </div>
          )}
          {searchError && (
            <div
              role="status"
              className="px-3 py-2 text-sm text-destructive border-b border-border last:border-b-0"
            >
              {searchError}
            </div>
          )}
          {/*
            The empty state lives INSIDE the dropdown now. It used to be a
            second absolutely-positioned box carrying identical
            `absolute z-50 mt-1 w-full` classes, so whenever a refusal coexisted
            with an empty result set the two rendered on top of each other at
            the same coordinates.
          */}
          {showNoResults && (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No results found for &ldquo;{query}&rdquo;
            </div>
          )}
          {/* Conversations Section (Consultants with consultations/subscriptions) */}
          {groupedConversations.length > 0 && (
            <>
              <div className="px-3 py-2 bg-muted border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Conversations
                </span>
              </div>
              {groupedConversations.map((conversation) => (
                <ConversationResultRow
                  key={conversation.channelId}
                  conversation={conversation}
                  onClick={() => handleConversationClick(conversation)}
                />
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
                    type="button"
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
                        {event.startsAt && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            {formatSessionTime(event.startsAt)}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
};
