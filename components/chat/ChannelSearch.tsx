"use client";

import { useState, useEffect, useCallback } from "react";
import { useChatContext } from "stream-chat-react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { Channel } from "stream-chat";

type SearchResult = {
  id: string;
  type: "channel" | "user";
  name: string;
  image?: string;
  channel?: Channel;
  user?: Record<string, unknown>;
};

export const ChannelSearch = () => {
  const { client, setActiveChannel } = useChatContext();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  const handleSearch = useCallback(async () => {
    if (!client || !query.trim()) return;

    try {
      setLoading(true);

      // Search for channels
      const channelResponse = await client.queryChannels({
        type: { $in: ["messaging", "team"] },
        name: { $autocomplete: query },
      });

      // Search for users
      // Note: $ne operator removed for performance (stream-chat v9 breaking change)
      // Filtering current user client-side instead
      const userResponse = await client.queryUsers({
        $or: [
          { name: { $autocomplete: query } },
          { id: { $autocomplete: query } },
        ],
      });

      const channels = channelResponse.map((channel: Channel) => ({
        id: channel.id || "",
        type: "channel" as const,
        name: channel.data?.name || channel.id || "",
        image: channel.data?.image as string | undefined,
        channel,
      }));

      // Filter out current user and system users client-side (replacing removed $ne operator)
      // System users like 'recording-egress-*' and 'system-*' should not appear in search
      const users = userResponse.users
        .filter((user) => {
          // Exclude current user
          if (user.id === client.userID) return false;
          // Exclude system users
          if (user.id.startsWith("recording-egress-")) return false;
          if (user.id.startsWith("system-")) return false;
          return true;
        })
        .map((user) => ({
          id: user.id,
          type: "user" as const,
          name: user.name || user.id,
          image: user.image as string | undefined,
          user: user as unknown as Record<string, unknown>,
        }));

      setSearchResults([...channels, ...users]);
    } catch (error) {
      console.error("Error searching channels:", error);
    } finally {
      setLoading(false);
    }
  }, [client, query]);

  // Debounced search effect
  useEffect(() => {
    if (!query.trim()) {
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

  return (
    <div className="channel-search relative">
      <form onSubmit={handleSearchSubmit} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-300" />
        <Input
          type="text"
          placeholder={loading ? "Searching..." : "Search"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full text-sm bg-blue-700 border-blue-600 text-white placeholder-blue-300 focus:border-blue-500 focus:ring-blue-500"
          disabled={loading}
        />
      </form>

      {searchResults.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-xl border max-h-60 overflow-auto">
          {searchResults.map((result) => (
            <button
              key={result.id}
              className="p-2 hover:bg-gray-100 cursor-pointer w-full text-left"
              onClick={() => {
                if (result.type === "channel" && result.channel) {
                  setActiveChannel(result.channel);
                } else if (result.type === "user") {
                  // Create a direct message channel with this user
                  const channel = client.channel("messaging", {
                    members: [client.userID || "", result.id],
                  });
                  channel.watch();
                  setActiveChannel(channel);
                }
                setQuery("");
                setSearchResults([]);
              }}
            >
              <div className="flex items-center">
                {result.image ? (
                  <img
                    src={result.image}
                    alt={result.name}
                    className="w-8 h-8 rounded-full mr-2"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center mr-2">
                    {result.name.charAt(0)}
                  </div>
                )}
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    {result.name}
                  </div>
                  <div className="text-xs text-gray-600">
                    {result.type === "channel" ? "Channel" : "User"}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
