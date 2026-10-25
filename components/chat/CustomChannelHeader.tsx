"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ArrowLeftIcon } from "lucide-react";
import { useChatContext } from "stream-chat-react";
import { ChannelInfoAndManageDialog } from "./ChannelInfoAndManageDialog";
import { useChatPane } from "./ChatPaneContext";
import {
  eventChannelSubtitle,
  getChannelDisplayInfo,
  getTruncatedDisplayName,
} from "./utils/channelUtils";
import { parseEventChannelId } from "@/lib/stream-channel-ids";

/**
 * The only way back to the channel list below `md`, where the conversation
 * covers it (#1134). Hidden from `md` up, where both panes are visible.
 */
const BackToListButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Back to conversations"
    className="-ml-1 mr-1 rounded-full p-2 hover:bg-muted md:hidden"
  >
    <ArrowLeftIcon className="h-5 w-5 text-muted-foreground" />
  </button>
);

export const CustomChannelHeader = () => {
  const { channel, client } = useChatContext();
  const { backToList } = useChatPane();

  if (!channel) return null;

  const isDirectMessage = channel.type === "messaging";

  if (isDirectMessage) {
    const displayInfo = getChannelDisplayInfo(channel, client?.userID);
    const truncatedName = getTruncatedDisplayName(displayInfo, 35);
    const showTooltip = truncatedName !== displayInfo.displayName;

    return (
      <div className="flex items-center px-4 py-2 border-b border-border bg-card">
        <BackToListButton onClick={backToList} />
        <div className="relative mr-3">
          <Avatar className="h-8 w-8">
            <AvatarImage
              src={displayInfo.displayImage || "/placeholder-user.jpg"}
            />
            <AvatarFallback>{displayInfo.displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          {displayInfo.isGroupDM && (
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border border-card flex items-center justify-center">
              <span className="text-[8px] text-primary-foreground font-bold">
                G
              </span>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div
            className="font-medium truncate"
            title={
              showTooltip
                ? displayInfo.fullGroupName || displayInfo.displayName
                : undefined
            }
          >
            {truncatedName}
          </div>
          <div className="text-xs text-muted-foreground">
            {displayInfo.statusText}
          </div>
        </div>

        <ChannelInfoAndManageDialog channel={channel} />
      </div>
    );
  }

  const displayName = channel.data?.name || channel.id || "";
  const memberCount =
    channel.data?.member_count ??
    Object.keys(channel.state.members || {}).length;
  const event = parseEventChannelId(channel.id);
  const subtitle = event
    ? eventChannelSubtitle({
        eventType: event.eventType,
        hostName: channel.data?.created_by?.name ?? null,
        memberCount,
      })
    : `${memberCount} ${memberCount === 1 ? "member" : "members"}`;

  return (
    <div className="flex items-center px-4 py-2 border-b border-border bg-card">
      <BackToListButton onClick={backToList} />
      <div className="flex items-center mr-3">
        <span className="text-muted-foreground mr-2">#</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{displayName}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>

      <ChannelInfoAndManageDialog channel={channel} />
    </div>
  );
};
