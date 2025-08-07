"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import type { Channel, Event } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { ChannelSearch } from "./ChannelSearch";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { CreateDirectMessageDialog } from "./CreateDirectMessageDialog";
import { InitializeUserChannelsButton } from "./InitializeUserChannelsButton";
import { DebugButton } from "./DebugButton";
import { Button } from "../ui/button";

// Empty state component for when there are no channels
const EmptyChannelState = () => (
  <div className="flex flex-col items-center justify-center p-8 text-center text-blue-200">
    <MessageSquareIcon className="w-16 h-16 mb-4 opacity-50" />
    <p className="text-sm">You have no channels currently</p>
    <p className="text-xs mt-2">Try creating a new channel or DM.</p>
  </div>
);

// Custom channel item component for the sidebar
const ChannelItem = ({
  channel,
  isActive,
  onClick,
}: {
  channel: Channel;
  isActive: boolean;
  onClick: () => void;
}) => {
  const { client } = useChatContext();
  const isTeamChannel = channel.type === "team";

  // For direct messages, get the other user's details
  let displayName = channel.data?.name || channel.id || "";
  let displayImage: string | undefined = undefined;

  if (!isTeamChannel && client) {
    // Find the other member in the channel
    const otherMember = Object.values(channel.state.members || {}).find(
      (member) => member.user?.id !== client.userID,
    )?.user;

    if (otherMember) {
      displayName = otherMember.name || otherMember.id || "Unknown User";
      displayImage = (otherMember.image as string) || undefined;
    }
  }

  // Get unread count directly from the channel
  const unreadCount = channel.countUnread();
  const hasUnread = unreadCount > 0;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2 hover:bg-blue-700 transition-colors ${isActive ? "bg-blue-700" : ""}`}
      title={displayName}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center min-w-0">
          {isTeamChannel ? (
            <div className="flex items-center min-w-0">
              <span className="text-blue-200 mr-2">#</span>
              <span
                className={`font-medium truncate ${hasUnread ? "font-bold" : ""}`}
              >
                {displayName}
              </span>
            </div>
          ) : (
            <div className="flex items-center min-w-0">
              <Avatar className="w-6 h-6 mr-2 flex-shrink-0">
                <AvatarImage src={displayImage || "/placeholder-user.jpg"} />
                <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
              </Avatar>
              <span
                className={`font-medium truncate ${hasUnread ? "font-bold" : ""}`}
              >
                {displayName}
              </span>
            </div>
          )}
        </div>

        {/* Unread indicator */}
        {hasUnread && (
          <div className="bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center ml-2 flex-shrink-0">
            {unreadCount > 9 ? "9+" : unreadCount}
          </div>
        )}
      </div>
    </button>
  );
};

export const ChatSidebar = () => {
  const { client, setActiveChannel } = useChatContext();
  const [teamChannels, setTeamChannels] = useState<Channel[]>([]);
  const [directMessages, setDirectMessages] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Function to fetch channels initially and on significant changes
  const fetchChannels = useCallback(async () => {
    if (!client?.userID) {
      console.log("Client or user ID not available yet.");
      // Don't set loading to false here, wait for client
      return;
    }

    setIsLoading(true);
    setError(null);
    console.log("Fetching channels for user:", client.userID, "with role:", client.user?.role);

    try {
      const filter = { members: { $in: [client.userID] } };
      const sort: { last_message_at: -1 } = { last_message_at: -1 };
      const options = {
        watch: true, // Crucial for real-time updates
        state: true,
        limit: 30, // Adjust limit as needed
        message_limit: 1, // Only need 1 message for unread status usually
        presence: true,
      };

      console.log("Channel query filter:", filter);
      console.log("Channel query options:", options);

      // Fetch channels in parallel
      const [teamResponse, dmResponse] = await Promise.all([
        client.queryChannels({ ...filter, type: "team" }, sort, options),
        client.queryChannels({ ...filter, type: "messaging" }, sort, options),
      ]);

      console.log(
        "Team channels found:",
        teamResponse.length,
        teamResponse.map((c) => ({ 
          id: c.cid, 
          name: c.data?.name,
          memberCount: Object.keys(c.state.members || {}).length,
          members: Object.keys(c.state.members || {}),
          userIsMember: client.userID ? (c.state.members?.[client.userID] ? true : false) : false
        })),
      );
      console.log(
        "DM channels found:",
        dmResponse.length,
        dmResponse.map((c) => ({ 
          id: c.cid,
          memberCount: Object.keys(c.state.members || {}).length,
          userIsMember: client.userID ? (c.state.members?.[client.userID] ? true : false) : false
        })),
      );

      setTeamChannels(teamResponse);
      setDirectMessages(dmResponse);
    } catch (err) {
      console.error("Error fetching channels:", err);
      console.error("Error details:", {
        error: err,
        userId: client.userID,
        userRole: client.user?.role,
        timestamp: new Date().toISOString()
      });
      setError("Failed to load channels. Please try refreshing.");
    } finally {
      setIsLoading(false);
    }
  }, [client]);

  // Handle individual channel deletion without full refresh
  const handleChannelDeleted = useCallback((deletedChannelId: string) => {
    console.log("Individual channel deleted:", deletedChannelId);
    
    // Remove from team channels
    setTeamChannels(prevChannels => {
      const filtered = prevChannels.filter(ch => ch.cid !== deletedChannelId);
      if (filtered.length !== prevChannels.length) {
        console.log("Removed team channel:", deletedChannelId);
      }
      return filtered;
    });
    
    // Remove from direct messages
    setDirectMessages(prevChannels => {
      const filtered = prevChannels.filter(ch => ch.cid !== deletedChannelId);
      if (filtered.length !== prevChannels.length) {
        console.log("Removed DM channel:", deletedChannelId);
      }
      return filtered;
    });
    
    // Clear active channel if it was the deleted one
    if (activeChannelId === deletedChannelId) {
      setActiveChannel(undefined);
      setActiveChannelId(null);
    }
  }, [activeChannelId, setActiveChannel]);

  // Handle user being removed from channel
  const handleUserRemovedFromChannel = useCallback((channelId: string) => {
    console.log("User removed from channel:", channelId);
    handleChannelDeleted(channelId); // Same logic as deletion
  }, [handleChannelDeleted]);

  // Handle individual channel creation without full refresh
  const handleChannelCreated = useCallback(async () => {
    console.log("Individual channel created - checking for new channels");
    
    if (!client?.userID) return;
    
    try {
      // Only query for channels that might have been just created
      // Use a more recent timestamp filter to avoid loading all channels
      const recentFilter = { 
        members: { $in: [client.userID] },
        // created_at: { $gte: new Date(Date.now() - 60000) } // Last minute
      };
      
      const [recentTeamChannels, recentDMChannels] = await Promise.all([
        client.queryChannels({ ...recentFilter, type: "team" }, { created_at: -1 }, { limit: 5, state: true }),
        client.queryChannels({ ...recentFilter, type: "messaging" }, { created_at: -1 }, { limit: 5, state: true }),
      ]);
      
      // Add any new channels to existing lists (avoiding duplicates)
      setTeamChannels(prevChannels => {
        const existingIds = new Set(prevChannels.map(ch => ch.cid));
        const newChannels = recentTeamChannels.filter(ch => !existingIds.has(ch.cid));
        if (newChannels.length > 0) {
          console.log("Adding new team channels:", newChannels.map(ch => ch.cid));
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });
      
      setDirectMessages(prevChannels => {
        const existingIds = new Set(prevChannels.map(ch => ch.cid));
        const newChannels = recentDMChannels.filter(ch => !existingIds.has(ch.cid));
        if (newChannels.length > 0) {
          console.log("Adding new DM channels:", newChannels.map(ch => ch.cid));
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });
      
    } catch (err) {
      console.error("Error handling individual channel creation:", err);
      // Fallback to full refresh if individual handling fails
      fetchChannels();
    }
  }, [client, fetchChannels]);

  // Manual refresh function
  const handleRefresh = () => {
    console.log("Manual refresh triggered");
    fetchChannels();
  };

  // Initial fetch and setup listeners
  useEffect(() => {
    if (client) {
      fetchChannels();

      // Listener for events that might require a channel list update
      const handleEvent = (event: Event) => {
        console.log("Stream event received:", event.type, event);

        let channelUpdated = false;

        // Update channel lists based on events
        if (
          event.type === "notification.added_to_channel" &&
          event.channel &&
          event.user?.id === client.userID
        ) {
          console.log(`Added to new channel ${event.channel.cid}`);
          const newChannel = client.channel(
            event.channel.type,
            event.channel.id,
          );
          if (event.channel.type === "team") {
            setTeamChannels((prev) => [newChannel, ...prev]);
          } else if (event.channel.type === "messaging") {
            setDirectMessages((prev) => [newChannel, ...prev]);
          }
          channelUpdated = true;
        } else if (
          event.type === "notification.removed_from_channel" &&
          event.channel &&
          event.user?.id === client.userID
        ) {
          console.log(`Removed from channel ${event.channel.cid}`);
          handleUserRemovedFromChannel(event.channel.cid || event.channel.id);
          channelUpdated = true;
        } else if (event.type === "channel.deleted" && event.channel) {
          console.log(`Channel deleted ${event.channel.cid}`);
          handleChannelDeleted(event.channel.cid || event.channel.id);
          channelUpdated = true;
        }

        // Refresh channel object in state if it was updated (e.g., new message, read status)
        // This relies on the channel object reference changing or having updated state
        if (
          event.channel &&
          !channelUpdated &&
          (event.type === "message.new" ||
            event.type === "notification.message_new" ||
            event.type === "message.read" ||
            event.type === "channel.updated")
        ) {
          const updatedChannel = client.channel(
            event.channel.type,
            event.channel.id,
          );
          console.log(
            `Updating channel state for ${event.channel.cid} due to ${event.type}`,
          );
          if (event.channel.type === "team") {
            setTeamChannels((prev) =>
              prev.map((ch) =>
                ch.cid === event.channel?.id ? updatedChannel : ch,
              ),
            );
          } else if (event.channel.type === "messaging") {
            setDirectMessages((prev) =>
              prev.map((ch) =>
                ch.cid === event.channel?.id ? updatedChannel : ch,
              ),
            );
          }
        }
      };

      client.on("*.**", handleEvent); // Listen to all events

      return () => {
        console.log("Removing Stream event listener");
        client.off("*.**", handleEvent);
      };
    } else {
      setIsLoading(true);
      setTeamChannels([]);
      setDirectMessages([]);
    }
  }, [client, fetchChannels, activeChannelId, setActiveChannel, handleChannelDeleted, handleUserRemovedFromChannel]); // Add dependencies

  const handleChannelSelect = (channel: Channel) => {
    setActiveChannelId(channel.cid || null);
    setActiveChannel(channel);
    // Optionally mark channel as read here if needed
    // channel.markRead();
  };

  return (
    <div className="w-64 bg-blue-600 text-white flex flex-col h-full">
      {/* Header with Title and Refresh */}
      <div className="p-4 border-b border-blue-700 flex justify-between items-center">
        <h1 className="text-xl font-bold">Familiarise</h1>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={isLoading}
          className="text-white hover:bg-blue-700 disabled:opacity-50"
          title="Refresh Channels"
        >
          <RefreshCwIcon
            className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {/* Search Bar */}
      <div className="p-4">
        <ChannelSearch />
      </div>

      {/* Channel Sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Team Channels Section */}
        <div className="px-4 py-2 flex justify-between items-center sticky top-0 bg-blue-600 z-10">
          <h2 className="font-semibold">Channels</h2>
          <CreateChannelDialog onChannelCreated={handleChannelCreated} />
        </div>
        {isLoading ? (
          <div className="p-4">
            <div className="animate-pulse space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-6 bg-blue-700 rounded w-full"></div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="p-4 text-center text-red-300">
            <p>{error}</p>
            <Button
              onClick={handleRefresh}
              variant="secondary"
              size="sm"
              className="mt-2"
            >
              Try Again
            </Button>
          </div>
        ) : teamChannels.length > 0 ? (
          <div>
            {teamChannels.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                isActive={channel.cid === activeChannelId}
                onClick={() => handleChannelSelect(channel)}
              />
            ))}
          </div>
        ) : (
          <div className="p-4 text-center text-blue-200 text-sm">
            No team channels found.
          </div>
        )}

        {/* Direct Messages Section */}
        <div className="mt-4 px-4 py-2 flex justify-between items-center sticky top-0 bg-blue-600 z-10">
          <h2 className="font-semibold">Direct Messages</h2>
          <CreateDirectMessageDialog onChannelCreated={handleChannelCreated} />
        </div>
        {isLoading ? (
          <div className="p-4">
            <div className="animate-pulse space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-8 bg-blue-700 rounded w-full"></div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="p-4 text-center text-red-300">
            {" "}
            {/* Error already shown above */}{" "}
          </div>
        ) : directMessages.length > 0 ? (
          <div>
            {directMessages.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                isActive={channel.cid === activeChannelId}
                onClick={() => handleChannelSelect(channel)}
              />
            ))}
          </div>
        ) : (
          <div className="p-4 text-center text-blue-200 text-sm">
            No direct messages found.
          </div>
        )}
      </div>

      {/* Footer Section */}
      <div className="p-4 border-t border-blue-700 mt-auto space-y-2">
        <InitializeUserChannelsButton
          userId={client?.userID || ""}
          className="w-full"
          onSuccess={handleRefresh}
        />
        <DebugButton 
          userId={client?.userID || ""} 
          variant="ghost"
          className="w-full text-blue-200 hover:bg-blue-700 hover:text-white"
        />
      </div>
    </div>
  );
};
