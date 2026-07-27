"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDistanceToNow } from "date-fns";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState, useCallback, useRef, memo, startTransition } from "react";
import type { Channel, Event } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { ChannelSearch } from "./ChannelSearch";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { InitializeUserChannelsButton } from "./InitializeUserChannelsButton";
import { DebugDialog } from "./DebugDialog";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { getChannelDisplayInfo } from "./utils/channelUtils";
import { useOrgScope } from "@/hooks/useOrgScope";

// Custom channel item component for the sidebar - memoized for performance
const ChannelItem = memo(
  ({
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

    // Get display info using shared utility
    const displayInfo = !isTeamChannel
      ? getChannelDisplayInfo(channel, client?.userID)
      : {
          displayName: channel.data?.name || channel.id || "",
          displayImage: undefined,
          isGroupDM: false,
          memberCount: Object.keys(channel.state.members || {}).length,
          statusText: "",
          fullGroupName: undefined,
        };

    const displayName = displayInfo.displayName;
    const displayImage = displayInfo.displayImage;
    const isGroupDM = displayInfo.isGroupDM;
    const memberCount = displayInfo.memberCount;

    // Get unread count directly from the channel
    const unreadCount = channel.countUnread();
    const hasUnread = unreadCount > 0;

    // Last message preview and timestamp
    const messages = channel.state.messages;
    const lastMessage =
      messages.length > 0 ? messages[messages.length - 1] : null;
    const lastMessageText = lastMessage?.text
      ? lastMessage.text.length > 30
        ? lastMessage.text.substring(0, 30) + "..."
        : lastMessage.text
      : lastMessage
        ? "Sent an attachment"
        : null;
    const lastMessageTime = lastMessage?.created_at
      ? formatDistanceToNow(new Date(lastMessage.created_at), {
          addSuffix: false,
        })
      : null;

    return (
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-2 hover:bg-blue-700 transition-colors ${isActive ? "bg-blue-700" : ""}`}
        title={displayName}
      >
        <div className="flex items-center min-w-0">
          {/* Avatar / channel icon */}
          {isTeamChannel ? (
            <span className="text-blue-200 mr-2 flex-shrink-0">#</span>
          ) : (
            <div className="relative mr-2 flex-shrink-0">
              <Avatar className="w-6 h-6">
                <AvatarImage
                  src={displayImage || "/placeholder-user.jpg"}
                />
                <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
              </Avatar>
              {isGroupDM && (
                <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-blue-500 rounded-full border border-blue-600 flex items-center justify-center">
                  <span className="text-[8px] text-white font-bold">G</span>
                </div>
              )}
            </div>
          )}

          {/* Two-row content area */}
          <div className="flex-1 min-w-0">
            {/* Row 1: channel name + timestamp */}
            <div className="flex items-center justify-between">
              <span
                className={`font-medium truncate ${hasUnread ? "font-bold" : ""}`}
                title={
                  isGroupDM
                    ? displayInfo.fullGroupName ||
                      `Group chat with ${memberCount} members`
                    : displayName
                }
              >
                {displayName}
              </span>
              {lastMessageTime && (
                <span className="text-[10px] text-blue-200 ml-2 flex-shrink-0">
                  {lastMessageTime}
                </span>
              )}
            </div>

            {/* Row 2: last message preview + unread badge */}
            <div className="flex items-center justify-between">
              {lastMessageText ? (
                <span className="text-xs text-blue-200 truncate">
                  {lastMessageText}
                </span>
              ) : (
                <span className="text-xs text-blue-300 italic truncate">
                  No messages yet
                </span>
              )}
              {hasUnread && (
                <div className="bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center ml-2 flex-shrink-0">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </div>
              )}
            </div>
          </div>
        </div>
      </button>
    );
  },
);

ChannelItem.displayName = "ChannelItem";

export const ChatSidebar = () => {
  const { client, setActiveChannel } = useChatContext();
  const userRole = client?.user?.role as string | undefined;
  // `all`, not the hook's `first-org` default. A conversation belongs to the
  // two people in it; scoping the inbox by who funded the session hid a
  // member's B2C chats behind their first org, and hid every conversation in a
  // second org entirely — with no picker to change it, since ADR 19 removed the
  // personal-dashboard context filter. The org still cannot read any of this;
  // see ADR 20. Chat is mounted only in the personal trees.
  const { scope } = useOrgScope({ defaultForOrgMember: "all" });
  const [teamChannels, setTeamChannels] = useState<Channel[]>([]);
  const [directMessages, setDirectMessages] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  // #248: mirror activeChannelId into a ref so handleChannelDeleted can read the
  // current selection WITHOUT depending on the state. Without this, every
  // channel selection changed handleChannelDeleted's identity, which re-ran the
  // event-listener effect and detached/re-attached the Stream listener on each
  // click. The listener effect now depends only on `client`.
  const activeChannelIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialSelectionDoneRef = useRef(false);
  // #248 dedupe: guard against overlapping/duplicate channel fetches. The
  // sidebar effect used to re-run (and refetch) on every channel selection and
  // on useCallback identity churn, firing the queryChannels storm. We track the
  // *key* (client+scope) currently in flight, not just a boolean: skipping only
  // the SAME key means an org-scope switch DURING an in-flight fetch is not
  // silently dropped (the prior bug left the new scope marked "fetched" while
  // showing the old scope's data).
  const inFlightFetchKeyRef = useRef<string | null>(null);
  // Tracks the client+scope we've SUCCESSFULLY fetched for, so the initial-fetch
  // effect is a no-op on unrelated re-renders. Recorded only after a request
  // succeeds (not when a fetch is skipped) so a skipped/failed fetch never
  // marks a scope as done. Refetch still happens on a genuine client/scope change.
  const fetchedKeyRef = useRef<string | null>(null);

  // Pagination state
  const [hasMoreTeamChannels, setHasMoreTeamChannels] = useState(true);
  const [hasMoreDMChannels, setHasMoreDMChannels] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Stable key for the current (client + org-scope) pair. Both the in-flight
  // guard and the "already fetched" record key off this so a scope switch is a
  // genuinely different key (and thus never skipped against an unrelated fetch).
  const computeFetchKey = useCallback((): string | null => {
    if (!client?.userID) return null;
    const scopeKey = scope.kind === "org" ? `org:${scope.orgId}` : scope.kind;
    return `${client.userID}::${scopeKey}`;
  }, [client, scope]);

  // Function to fetch channels initially and on significant changes
  const fetchChannels = useCallback(async () => {
    if (!client?.userID) {
      console.log("Client or user ID not available yet.");
      // Don't set loading to false here, wait for client
      return;
    }

    const fetchKey = computeFetchKey();

    // #248 dedupe: skip only if the SAME key is already in flight. A different
    // key (e.g. an org-scope switch mid-fetch) must proceed so the new scope
    // actually loads instead of inheriting the in-flight scope's result.
    if (inFlightFetchKeyRef.current === fetchKey) {
      return;
    }
    inFlightFetchKeyRef.current = fetchKey;

    setIsLoading(true);
    setError(null);
    console.log(
      "Fetching channels for user:",
      client.userID,
      "with role:",
      client.user?.role,
    );

    try {
      // #674 org-scope filter — Stream channels created by the
      // enterprise wiring carry a `custom.organization_id` field.
      // Without scoping, a consultant in Acme + Zeta sees every chat
      // cross-tenanted in one inbox. Apply the same three-mode shape
      // as the server-side resolveOrgScope:
      //   - personal → channels with no organization_id (legacy/B2C)
      //   - org:<id> → channels tagged with that org id
      //   - all     → no scope filter (admin-only)
      const orgFilter: Record<string, unknown> =
        scope.kind === "personal"
          ? { organization_id: { $exists: false } }
          : scope.kind === "org"
            ? { organization_id: { $eq: scope.orgId } }
            : {};
      const filter = {
        members: { $in: [client.userID] },
        ...orgFilter,
      };
      const sort: { last_message_at: -1 } = { last_message_at: -1 };
      const options = {
        watch: true, // Crucial for real-time updates
        state: true,
        limit: 20, // Reduced initial limit for faster loading
        message_limit: 100, // Load recent messages for proper chat history and scroll functionality
        presence: false, // Disable presence for initial load to improve performance
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
          userIsMember: client.userID
            ? c.state.members?.[client.userID]
              ? true
              : false
            : false,
        })),
      );
      console.log(
        "DM channels found:",
        dmResponse.length,
        dmResponse.map((c) => ({
          id: c.cid,
          memberCount: Object.keys(c.state.members || {}).length,
          userIsMember: client.userID
            ? c.state.members?.[client.userID]
              ? true
              : false
            : false,
        })),
      );

      // Staleness guard: if a newer-keyed fetch (e.g. a scope switch) started
      // while this request was in flight, drop this late response instead of
      // overwriting the current scope's channels with the old scope's data.
      if (inFlightFetchKeyRef.current !== fetchKey) {
        return;
      }

      setTeamChannels(teamResponse);
      setDirectMessages(dmResponse);

      // Update pagination state
      setHasMoreTeamChannels(teamResponse.length === options.limit);
      setHasMoreDMChannels(dmResponse.length === options.limit);

      // Record success: only NOW is this scope's data actually loaded. Marking
      // it earlier (or on skip) is what let a switched scope show stale data.
      fetchedKeyRef.current = fetchKey;

      // Auto-select the most recent channel on initial load
      if (!initialSelectionDoneRef.current) {
        initialSelectionDoneRef.current = true;
        const mostRecentTeam = teamResponse[0];
        const mostRecentDM = dmResponse[0];
        let channelToSelect = null;
        if (mostRecentTeam && mostRecentDM) {
          const teamTime = new Date(
            (mostRecentTeam.data?.last_message_at as string) || 0,
          ).getTime();
          const dmTime = new Date(
            (mostRecentDM.data?.last_message_at as string) || 0,
          ).getTime();
          channelToSelect =
            dmTime >= teamTime ? mostRecentDM : mostRecentTeam;
        } else {
          channelToSelect = mostRecentTeam || mostRecentDM || null;
        }
        if (channelToSelect) {
          setActiveChannel(channelToSelect);
          setActiveChannelId(channelToSelect.cid || null);
        }
      }
    } catch (err) {
      console.error("Error fetching channels:", err);
      console.error("Error details:", {
        error: err,
        userId: client.userID,
        userRole: client.user?.role,
        timestamp: new Date().toISOString(),
      });
      setError("Failed to load channels. Please try refreshing.");
    } finally {
      setIsLoading(false);
      // #248: release the in-flight guard only if WE are still the in-flight
      // fetch. If a newer-keyed fetch started after us, leave its key in place
      // so it isn't wrongly treated as not-in-flight.
      if (inFlightFetchKeyRef.current === fetchKey) {
        inFlightFetchKeyRef.current = null;
      }
    }
    // Why `scope` is in deps: when the operator toggles the org-context
    // dropdown (or navigates into /dashboard/organization/<orgId>/...),
    // useOrgScope's `scope` shifts and we must refetch the channel list
    // through the new filter. Without this, the inbox keeps showing the
    // previous tenant's threads until a hard reload.
  }, [client, setActiveChannel, scope, computeFetchKey]);

  // Function to load more channels (pagination)
  const loadMoreChannels = useCallback(
    async (type: "team" | "messaging") => {
      if (!client?.userID || isLoadingMore) return;

      const currentChannels = type === "team" ? teamChannels : directMessages;
      const hasMore = type === "team" ? hasMoreTeamChannels : hasMoreDMChannels;

      if (!hasMore) return;

      setIsLoadingMore(true);

      try {
        // Mirror the org-scope filter from `fetchChannels` so the
        // load-more page stays in the same tenant context.
        const orgFilter: Record<string, unknown> =
          scope.kind === "personal"
            ? { organization_id: { $exists: false } }
            : scope.kind === "org"
              ? { organization_id: { $eq: scope.orgId } }
              : {};
        const filter = {
          members: { $in: [client.userID] },
          type,
          ...orgFilter,
        };
        const sort: { last_message_at: -1 } = { last_message_at: -1 };

        const offset = currentChannels.length;

        const options = {
          watch: true,
          state: true,
          limit: 20,
          message_limit: 100, // Load messages for paginated channels too
          presence: false,
          offset,
        };

        console.log(`Loading more ${type} channels from offset ${offset}`);

        const response = await client.queryChannels(filter, sort, options);

        if (type === "team") {
          setTeamChannels((prev) => [...prev, ...response]);
          setHasMoreTeamChannels(response.length === options.limit);
        } else {
          setDirectMessages((prev) => [...prev, ...response]);
          setHasMoreDMChannels(response.length === options.limit);
        }

        console.log(`Loaded ${response.length} more ${type} channels`);
      } catch (error) {
        console.error(`Error loading more ${type} channels:`, error);
      } finally {
        setIsLoadingMore(false);
      }
    },
    [
      client,
      teamChannels,
      directMessages,
      hasMoreTeamChannels,
      hasMoreDMChannels,
      isLoadingMore,
      scope,
    ],
  );

  // Handle individual channel deletion without full refresh
  const handleChannelDeleted = useCallback(
    (deletedChannelId: string) => {
      console.log("Individual channel deleted:", deletedChannelId);

      // Remove from team channels
      setTeamChannels((prevChannels) => {
        const filtered = prevChannels.filter(
          (ch) => ch.cid !== deletedChannelId,
        );
        if (filtered.length !== prevChannels.length) {
          console.log("Removed team channel:", deletedChannelId);
        }
        return filtered;
      });

      // Remove from direct messages
      setDirectMessages((prevChannels) => {
        const filtered = prevChannels.filter(
          (ch) => ch.cid !== deletedChannelId,
        );
        if (filtered.length !== prevChannels.length) {
          console.log("Removed DM channel:", deletedChannelId);
        }
        return filtered;
      });

      // Clear active channel if it was the deleted one. Read the ref (not the
      // state) so this handler's identity stays stable across selections and the
      // event-listener effect below isn't re-run on every channel click.
      if (activeChannelIdRef.current === deletedChannelId) {
        setActiveChannel(undefined);
        setActiveChannelId(null);
      }
    },
    [setActiveChannel],
  );

  // Handle user being removed from channel
  const handleUserRemovedFromChannel = useCallback(
    (channelId: string) => {
      console.log("User removed from channel:", channelId);
      handleChannelDeleted(channelId); // Same logic as deletion
    },
    [handleChannelDeleted],
  );

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
        client.queryChannels(
          { ...recentFilter, type: "team" },
          { created_at: -1 },
          { limit: 5, state: true },
        ),
        client.queryChannels(
          { ...recentFilter, type: "messaging" },
          { created_at: -1 },
          { limit: 5, state: true },
        ),
      ]);

      // Add any new channels to existing lists (avoiding duplicates)
      setTeamChannels((prevChannels) => {
        const existingIds = new Set(prevChannels.map((ch) => ch.cid));
        const newChannels = recentTeamChannels.filter(
          (ch) => !existingIds.has(ch.cid),
        );
        if (newChannels.length > 0) {
          console.log(
            "Adding new team channels:",
            newChannels.map((ch) => ch.cid),
          );
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });

      setDirectMessages((prevChannels) => {
        const existingIds = new Set(prevChannels.map((ch) => ch.cid));
        const newChannels = recentDMChannels.filter(
          (ch) => !existingIds.has(ch.cid),
        );
        if (newChannels.length > 0) {
          console.log(
            "Adding new DM channels:",
            newChannels.map((ch) => ch.cid),
          );
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

  // #248: Initial fetch — runs once per (client + org-scope), NOT on every
  // channel selection. Previously this lived in the same effect as the event
  // listener, whose deps included `activeChannelId`; selecting a channel
  // re-ran the effect and refired the full queryChannels pair, producing the
  // home/chat call-storm. The key guard makes unrelated re-renders a no-op
  // while still refetching on a real client or scope change.
  useEffect(() => {
    if (!client?.userID) {
      setIsLoading(true);
      setTeamChannels([]);
      setDirectMessages([]);
      fetchedKeyRef.current = null;
      inFlightFetchKeyRef.current = null;
      return;
    }

    const fetchKey = computeFetchKey();
    if (fetchedKeyRef.current === fetchKey) {
      return; // already SUCCESSFULLY fetched for this client+scope
    }
    // Do NOT pre-mark fetchedKeyRef here — fetchChannels records it only after
    // its request succeeds, so a skipped (in-flight) or failed fetch can't leave
    // a scope marked done with another scope's data.
    // Reset auto-selection so a scope switch can pick a fresh default channel.
    initialSelectionDoneRef.current = false;
    fetchChannels();
  }, [client, scope, fetchChannels, computeFetchKey]);

  // #248: Event listener — attached once per client (not per channel click).
  // Kept separate from the initial fetch so selecting a channel no longer tears
  // down/re-attaches the listener or refires queryChannels.
  useEffect(() => {
    if (client) {
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
    }
    // #248: deps intentionally exclude `fetchChannels` and `activeChannelId` so
    // the listener is not re-attached on every channel selection. It re-attaches
    // only when the client or the channel-mutation handlers genuinely change.
  }, [client, handleChannelDeleted, handleUserRemovedFromChannel]);

  const handleChannelSelect = useCallback(
    (channel: Channel) => {
      // Use startTransition for non-urgent updates to improve perceived performance
      startTransition(() => {
        setActiveChannelId(channel.cid || null);
      });

      // Set active channel immediately for instant feedback
      setActiveChannel(channel);

      // Mark channel as read asynchronously (only if channel is properly initialized)
      if (channel.initialized && channel.cid) {
        channel.markRead().catch(() => {
          // Silently ignore markRead errors - they can occur during rapid channel switching
        });
      }
    },
    [setActiveChannel],
  );

  // #248: keep activeChannelIdRef in lockstep with the state so the stable
  // handleChannelDeleted handler can read the current selection from the ref.
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Debug Stream tools: local hostname only — never on deployed/preview hosts
  // even if NODE_ENV were somehow still "development".
  const [showLocalDebugTools, setShowLocalDebugTools] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const host = window.location.hostname;
    setShowLocalDebugTools(host === "localhost" || host === "127.0.0.1");
  }, []);

  return (
    <div className="w-80 bg-blue-600 text-white flex flex-col h-full">
      {/* Header with Title and Refresh */}
      <div className="p-4 border-b border-blue-700 flex justify-between items-center">
        <h1 className="text-xl font-bold">Chats</h1>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                disabled={isLoading}
                className="text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Refresh channels</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
            {hasMoreTeamChannels && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMoreChannels("team")}
                  disabled={isLoadingMore}
                  className="w-full text-blue-200 hover:bg-blue-700 text-sm"
                >
                  {isLoadingMore
                    ? "Loading..."
                    : `Showing ${teamChannels.length} channels — Load more`}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-blue-200 text-sm">
            No team channels found.
          </div>
        )}

        {/* Conversations Section (Consultations, Subscriptions) */}
        <div className="mt-4 px-4 py-2 sticky top-0 bg-blue-600 z-10">
          <h2 className="font-semibold">Conversations</h2>
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
            {hasMoreDMChannels && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMoreChannels("messaging")}
                  disabled={isLoadingMore}
                  className="w-full text-blue-200 hover:bg-blue-700 text-sm"
                >
                  {isLoadingMore
                    ? "Loading..."
                    : `Showing ${directMessages.length} conversations — Load more`}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-blue-200 text-sm">
            {userRole === "consultant"
              ? "No conversations yet. Conversations will appear here once clients book sessions."
              : "No conversations yet. Book a consultation to start chatting."}
          </div>
        )}
      </div>

      {/* Footer Section — Debug tools, localhost only */}
      {showLocalDebugTools && (
        <div className="mt-auto space-y-2 border-t border-blue-700 p-4">
          <InitializeUserChannelsButton
            userId={client?.userID || ""}
            className="w-full"
            onSuccess={handleRefresh}
          />
          <DebugDialog
            userId={client?.userID || ""}
            variant="ghost"
            className="w-full text-blue-200 hover:bg-blue-700 hover:text-white"
          />
        </div>
      )}
    </div>
  );
};
