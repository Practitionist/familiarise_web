"use client";

import { memo, useEffect, useReducer } from "react";
import { MoreVerticalIcon, PinIcon, ShieldCheckIcon } from "lucide-react";
import type { Channel } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  channelHasSupportMember,
  formatRowTime,
  getChannelDisplayInfo,
  lastVisibleMessage,
} from "./utils/channelUtils";

/**
 * Events after which a row's preview, time or unread count may differ. The SDK's
 * own list row subscribes to the same ones.
 */
const ROW_CHANNEL_EVENTS = [
  "message.new",
  "message.updated",
  "message.deleted",
  "message.undeleted",
  "channel.truncated",
  "message.read",
  "message.read_locally",
  "notification.mark_unread",
] as const;

/** The one-line preview a row shows for its last message. */
function previewText(message: { text?: string } | null): string | null {
  if (!message) return null;
  if (!message.text) return "Sent an attachment";
  return message.text.length > 30
    ? `${message.text.substring(0, 30)}...`
    : message.text;
}

/**
 * One row of the sidebar list.
 *
 * It reads the channel's mutable state (last message, unread count), which a memoized
 * component is never told about, so it subscribes to its own channel and redraws itself.
 */
export const ChannelItem = memo(
  ({
    channel,
    isActive,
    isPinned,
    onClick,
    onTogglePin,
    onRemove,
  }: {
    channel: Channel;
    isActive: boolean;
    isPinned: boolean;
    onClick: () => void;
    onTogglePin: (channel: Channel, pin: boolean) => void;
    onRemove: (channel: Channel) => void;
  }) => {
    const { client } = useChatContext();
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      const subscriptions = ROW_CHANNEL_EVENTS.map((type) =>
        channel.on(type, redraw),
      );
      // Marking everything read resets every row at once.
      const markedRead = client?.on("notification.mark_read", redraw);
      return () => {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        markedRead?.unsubscribe();
      };
    }, [channel, client]);
    const isTeamChannel = channel.type === "team";

    const displayInfo = !isTeamChannel
      ? getChannelDisplayInfo(channel, client?.userID)
      : {
          displayName: channel.data?.name || channel.id || "",
          displayImage: undefined,
          isGroupDM: false,
          memberCount: Object.keys(channel.state.members || {}).length,
          statusText: "",
          fullGroupName: undefined,
          hasSupport: channelHasSupportMember(channel),
        };

    const displayName = displayInfo.displayName;
    const displayImage = displayInfo.displayImage;
    const isGroupDM = displayInfo.isGroupDM;
    const memberCount = displayInfo.memberCount;
    const hasSupport = displayInfo.hasSupport;

    const unreadCount = channel.countUnread();
    const hasUnread = unreadCount > 0;

    const lastMessage = lastVisibleMessage(channel.state.messages);
    const lastMessageText = previewText(lastMessage);
    const lastMessageTime = lastMessage?.created_at
      ? formatRowTime(lastMessage.created_at)
      : null;

    return (
      <div
        className={`group relative transition-colors ${isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
      >
        <button
          onClick={onClick}
          // `pr-9` keeps the row's text clear of the options button.
          className="w-full text-left py-2 pl-4 pr-9"
          title={displayName}
          aria-current={isActive ? "true" : undefined}
        >
          <div className="flex items-center min-w-0">
            {isTeamChannel ? (
              <span className="text-muted-foreground mr-2 flex-shrink-0">
                #
              </span>
            ) : (
              <div className="relative mr-2 flex-shrink-0">
                <Avatar className="w-6 h-6">
                  {/* No placeholder fallback src — it always loaded, so the
                      initials below were unreachable. */}
                  <AvatarImage src={displayImage} />
                  <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
                </Avatar>
                {isGroupDM && (
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border border-card flex items-center justify-center">
                    <span className="text-[8px] text-primary-foreground font-bold">
                      G
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center">
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
                  {hasSupport && (
                    <span
                      data-testid="support-presence-badge"
                      className="ml-1.5 inline-flex flex-shrink-0 items-center gap-0.5 rounded bg-info/10 px-1 text-[10px] font-medium text-info"
                      title="Familiarise Support is in this chat"
                    >
                      <ShieldCheckIcon className="h-3 w-3" aria-hidden="true" />
                      <span aria-hidden="true">Support</span>
                      <span className="sr-only">
                        Familiarise Support is in this chat
                      </span>
                    </span>
                  )}
                </div>
                {lastMessageTime && (
                  <span className="text-[10px] text-muted-foreground ml-2 flex-shrink-0">
                    {lastMessageTime}
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between">
                {lastMessageText ? (
                  <span className="text-xs text-muted-foreground truncate">
                    {lastMessageText}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground italic truncate">
                    No messages yet
                  </span>
                )}
                {isPinned && (
                  <span className="ml-2 flex-shrink-0 text-muted-foreground">
                    <PinIcon className="h-3 w-3" aria-hidden="true" />
                    <span className="sr-only">Pinned</span>
                  </span>
                )}
                {hasUnread && (
                  <div className="bg-destructive text-destructive-foreground text-xs rounded-full w-5 h-5 flex items-center justify-center ml-2 flex-shrink-0">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </div>
                )}
              </div>
            </div>
          </div>
        </button>

        {/* A sibling of the row button, not a child: a button cannot hold a button.
            Always visible below `md`, where there is no hover. */}
        {/* Non-modal: a modal menu marks the rest of the page aria-hidden while the
            composer still holds focus, which the browser reports as an error. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Options for ${displayName}`}
              className="absolute right-1 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100"
            >
              <MoreVerticalIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onTogglePin(channel, !isPinned)}>
              {isPinned ? "Unpin" : "Pin to top"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRemove(channel)}>
              Remove from list
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
);

ChannelItem.displayName = "ChannelItem";
