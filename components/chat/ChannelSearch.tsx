"use client";

import { useState, useEffect } from "react";
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (!query) {
      setSearchResults([]);
    }
  }, [query]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!query) {
      return;
    }

    try {
      setLoading(true);

      // Search for channels
      const channelResponse = await client.queryChannels({
        type: { $in: ["messaging", "team"] },
        name: { $autocomplete: query },
      });

      // Search for users
      const userResponse = await client.queryUsers({
        id: { $ne: client.userID || "" },
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

      const users = userResponse.users.map((user: Record<string, unknown>) => ({
        id: user.id as string,
        type: "user" as const,
        name: (user.name as string) || (user.id as string),
        image: user.image as string,
        user,
      }));

      setSearchResults([...channels, ...users]);
    } catch (error) {
      console.error("Error searching channels:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="channel-search">
      <form onSubmit={handleSearch} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          type="text"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full text-sm bg-blue-700 border-blue-700 text-white placeholder-blue-300"
        />
      </form>

      {searchResults.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white rounded-md shadow-lg max-h-60 overflow-auto">
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
                  <div className="font-medium">{result.name}</div>
                  <div className="text-xs text-gray-500">
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
