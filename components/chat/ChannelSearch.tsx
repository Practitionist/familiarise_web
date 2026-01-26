"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useChatContext } from "stream-chat-react";
import { SearchIcon, UserIcon, VideoIcon, BookOpenIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AppointmentSearchResult } from "@/app/api/stream/channels/search-appointments/route";

// Type badge configuration for events (webinars/classes)
const EVENT_TYPE_CONFIG = {
  webinar: {
    label: "Webinar",
    icon: VideoIcon,
    bgColor: "bg-orange-100",
    textColor: "text-orange-700",
  },
  class: {
    label: "Class",
    icon: BookOpenIcon,
    bgColor: "bg-green-100",
    textColor: "text-green-700",
  },
} as const;

// Grouped consultant result for conversations (consultations + subscriptions)
type GroupedConsultant = {
  consultantName: string;
  consultantImage?: string;
  hasConsultation: boolean;
  hasSubscription: boolean;
  // Use the first available channel for navigation
  channelId: string;
  channelType: "consultation" | "subscription";
};

export const ChannelSearch = () => {
  const { client, setActiveChannel } = useChatContext();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AppointmentSearchResult[]>(
    [],
  );

  // Group consultations/subscriptions by consultant, keep events separate
  const { groupedConsultants, events } = useMemo(() => {
    const consultantMap = new Map<string, GroupedConsultant>();
    const eventResults: AppointmentSearchResult[] = [];

    // Defensive check in case searchResults is undefined
    if (!searchResults || !Array.isArray(searchResults)) {
      return { groupedConsultants: [], events: [] };
    }

    for (const result of searchResults) {
      if (result.type === "consultation" || result.type === "subscription") {
        // Group by consultant name
        const existing = consultantMap.get(result.consultantName);
        if (existing) {
          if (result.type === "consultation") existing.hasConsultation = true;
          if (result.type === "subscription") existing.hasSubscription = true;
        } else {
          consultantMap.set(result.consultantName, {
            consultantName: result.consultantName,
            consultantImage: result.consultantImage,
            hasConsultation: result.type === "consultation",
            hasSubscription: result.type === "subscription",
            channelId: result.channelId,
            channelType: result.type,
          });
        }
      } else {
        // Webinars and classes shown individually
        eventResults.push(result);
      }
    }

    return {
      groupedConsultants: Array.from(consultantMap.values()),
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

  // Handle click on grouped consultant (for conversations)
  const handleConsultantClick = async (consultant: GroupedConsultant) => {
    if (!client) return;

    try {
      // Conversations use messaging channel type
      const channel = client.channel("messaging", consultant.channelId);
      await channel.watch();
      setActiveChannel(channel);
    } catch (error) {
      console.error("Error opening channel:", error);
    }

    // Clear search
    setQuery("");
    setSearchResults([]);
  };

  // Handle click on event (webinar/class)
  const handleEventClick = async (result: AppointmentSearchResult) => {
    if (!client) return;

    try {
      // Events use team channel type
      const channel = client.channel("team", result.channelId);
      await channel.watch();
      setActiveChannel(channel);
    } catch (error) {
      console.error("Error opening channel:", error);
    }

    // Clear search
    setQuery("");
    setSearchResults([]);
  };

  const hasResults = groupedConsultants.length > 0 || events.length > 0;

  return (
    <div className="channel-search relative">
      <form onSubmit={handleSearchSubmit} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-300" />
        <Input
          type="text"
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full text-sm bg-blue-700 border-blue-600 text-white placeholder-blue-300 focus:border-blue-500 focus:ring-blue-500 normal-case"
        />
      </form>

      {hasResults && (
        <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-xl border max-h-72 overflow-auto">
          {/* Conversations Section (Consultants with consultations/subscriptions) */}
          {groupedConsultants.length > 0 && (
            <>
              <div className="px-3 py-2 bg-gray-50 border-b">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Conversations
                </span>
              </div>
              {groupedConsultants.map((consultant) => (
                <button
                  key={consultant.consultantName}
                  className="p-3 hover:bg-gray-50 cursor-pointer w-full text-left border-b last:border-b-0"
                  onClick={() => handleConsultantClick(consultant)}
                >
                  <div className="flex items-center gap-3">
                    {/* Consultant Image */}
                    {consultant.consultantImage ? (
                      <img
                        src={consultant.consultantImage}
                        alt={consultant.consultantName}
                        className="w-10 h-10 rounded-full flex-shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                        <span className="text-gray-600 font-medium">
                          {consultant.consultantName.charAt(0)}
                        </span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      {/* Consultant Name */}
                      <div className="font-semibold text-gray-900 truncate">
                        {consultant.consultantName}
                      </div>

                      {/* Type indicators */}
                      <div className="flex items-center gap-1 mt-1">
                        <UserIcon className="w-3 h-3 text-gray-400" />
                        <span className="text-xs text-gray-500">
                          {consultant.hasConsultation &&
                          consultant.hasSubscription
                            ? "Consultation & Subscription"
                            : consultant.hasConsultation
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
              <div className="px-3 py-2 bg-gray-50 border-b">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
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
                    className="p-3 hover:bg-gray-50 cursor-pointer w-full text-left border-b last:border-b-0"
                    onClick={() => handleEventClick(event)}
                  >
                    <div className="flex items-start gap-3">
                      {/* Consultant Image */}
                      {event.consultantImage ? (
                        <img
                          src={event.consultantImage}
                          alt={event.consultantName}
                          className="w-10 h-10 rounded-full flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                          <span className="text-gray-600 font-medium">
                            {event.consultantName.charAt(0)}
                          </span>
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        {/* Event Name */}
                        <div className="font-semibold text-gray-900 truncate">
                          {event.name}
                        </div>

                        {/* Type Badge + Consultant Name */}
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.bgColor} ${config.textColor}`}
                          >
                            <Icon className="w-3 h-3" />
                            {config.label}
                          </span>
                          <span className="text-sm text-gray-500 truncate">
                            {event.consultantName}
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
        <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-xl border p-4 text-center text-gray-500 text-sm">
          No results found for "{query}"
        </div>
      )}
    </div>
  );
};
