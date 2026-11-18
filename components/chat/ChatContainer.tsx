"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Channel,
  DateSeparator,
  EmptyStateIndicator,
  MessageList,
  VirtualizedMessageList,
  Window,
  WithComponents,
  useChannelStateContext,
  useChatContext,
  type DateSeparatorProps,
  type EmptyStateIndicatorProps,
} from "stream-chat-react";
import { AlertTriangle } from "lucide-react";
import { AppointmentDocumentsHint } from "./AppointmentDocumentsHint";
import { BookingTagComposer } from "./BookingTag";
import { ComposerDraftPersistence } from "./ComposerDraftPersistence";
import { CustomChannelHeader } from "./CustomChannelHeader";
import { CustomMessage } from "./CustomMessage";
import { FrozenChannelNotice } from "./FrozenChannelNotice";
import { SupportInterventionBanner } from "./SupportInterventionBanner";
import { SystemMessage } from "./SystemMessage";
import { StreamChatErrorBoundary } from "@/components/stream/StreamErrorBoundary";
import { useMaintenanceState } from "@/providers/MaintenanceProvider";
import { isEventChannel, parseEventChannelId } from "@/lib/stream-channel-ids";
import { useChatPane } from "./ChatPaneContext";
import { EmptyState } from "@/components/dashboard/DataCard";
import { withoutLegacyBookingCards } from "@/lib/stream/system-users";
import { useMediaQuery } from "@/hooks/use-media-query";

// Was a hand-rolled near-copy of EmptyState with different dimensions, on a
// `bg-zinc-50` slab pressed against the sidebar's blue. ChatUnavailable already
// used the shared one; this matches it.
const EMPTY_COPY = {
  none: {
    title: "No conversation selected",
    description: "Pick a conversation from the list to start chatting.",
  },
  event: {
    title: "This event chat is no longer available to you",
    description:
      "You are no longer on this event, so its chat is closed to you. Pick another conversation from the list.",
  },
  conversation: {
    title: "This conversation is no longer available to you",
    description: "Pick another conversation from the list.",
  },
} as const;

const EmptyChannelState = () => {
  const copy = EMPTY_COPY[useChatPane().unavailableLink ?? "none"];
  return (
    <div className="flex h-full w-full items-center justify-center bg-card p-8">
      <EmptyState
        icon={MessageSquareIcon}
        title={copy.title}
        description={copy.description}
      />
    </div>
  );
};

// An empty class or webinar channel invites the first message; DMs keep the SDK default.
const ChannelEmptyState = (props: EmptyStateIndicatorProps) => {
  const { channel } = useChannelStateContext();
  const event = parseEventChannelId(channel.id);
  if (!event || props.listType !== "message") {
    return <EmptyStateIndicator {...props} />;
  }
  // Nothing can be sent to a frozen channel, so do not invite the first message.
  if (channel.data?.frozen) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No messages were sent in this channel.
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      {event.eventType === "class"
        ? "Say hello to your class"
        : "Say hello to everyone in this webinar"}
    </div>
  );
};

// On a phone the floating "Today" pill sits over the top bubble; the in-list separators stay.
const ChatDateSeparator = (props: DateSeparatorProps) => {
  const narrow = useMediaQuery("(max-width: 640px)");
  if (props.floating && narrow) return null;
  return <DateSeparator {...props} />;
};

// System messages bypass `Message` and render through `MessageSystem`.
// `uploads: false` still leaves the selector for commands/polls/location.
const AttachmentSelectorOff = () => null;
const CHAT_COMPONENT_OVERRIDES = {
  MessageSystem: SystemMessage,
  AttachmentSelector: AttachmentSelectorOff,
  EmptyStateIndicator: ChannelEmptyState,
  DateSeparator: ChatDateSeparator,
};

/** The loaded messages minus the retired booking cards, so a DM holding only those shows the empty state. */
const VisibleMessageList = ({ virtualized }: { virtualized: boolean }) => {
  const { messages } = useChannelStateContext();
  const visible = useMemo(
    () => withoutLegacyBookingCards(messages ?? []),
    [messages],
  );
  return virtualized ? (
    <VirtualizedMessageList
      messages={visible}
      Message={CustomMessage}
      defaultItemHeight={62}
      additionalVirtuosoProps={{ increaseViewportBy: 200, overscan: 5 }}
    />
  ) : (
    <MessageList messages={visible} Message={CustomMessage} />
  );
};

/** The composer, or the reason there is none when the conversation is frozen. */
const ComposerArea = ({
  contextAppointmentId,
}: {
  contextAppointmentId: string | null;
}) => {
  const { channel } = useChannelStateContext();
  if (channel?.data?.frozen) {
    return <FrozenChannelNotice channelType={channel.type} />;
  }
  return (
    <div className="w-full shrink-0">
      <AppointmentDocumentsHint />
      <ComposerDraftPersistence />
      <BookingTagComposer contextAppointmentId={contextAppointmentId} />
    </div>
  );
};

/** `contextAppointmentId` offers the booking chip in a DM both people are parties to. */
export const ChatContainer = ({
  contextAppointmentId = null,
}: Readonly<{ contextAppointmentId?: string | null }>) => {
  const { channel } = useChatContext();
  const { phase } = useMaintenanceState();
  const [hasChannel, setHasChannel] = useState(false);
  const [shouldUseVirtualized, setShouldUseVirtualized] = useState(false);

  const isChatReadOnly = phase === "DEGRADED" || phase === "OFFLINE";

  useEffect(() => {
    setHasChannel(!!channel);

    if (channel) {
      // Determine if we should use virtualized list based on:
      // 1. Channel member count (>10 members suggests group chat)
      // 2. Channel type (team channels are typically higher traffic)
      // 3. Message count estimation
      const memberCount = Object.keys(channel.state.members || {}).length;
      const messageCount = channel.state.messages.length;
      const isTeamChannel = channel.type === "team";

      // Use virtualized list for:
      // - Team channels with >5 members
      // - Any channel with >100 messages currently loaded
      // - Webinar/class channels (identified by channel ID pattern)
      const isHighTrafficChannel =
        (isTeamChannel && memberCount > 5) ||
        messageCount > 100 ||
        isEventChannel(channel.id);

      setShouldUseVirtualized(isHighTrafficChannel || false);
    }
  }, [channel]);

  if (!hasChannel) {
    return <EmptyChannelState />;
  }

  // Threads stay off: no `<Thread>` is mounted and `CustomMessage` replaces the
  // SDK message UI.
  return (
    <StreamChatErrorBoundary>
      <div className="flex-1 flex flex-col h-full">
        <Channel>
          <WithComponents overrides={CHAT_COMPONENT_OVERRIDES}>
            <Window>
              <CustomChannelHeader />
              <SupportInterventionBanner />
              {/* Only the message list scrolls; the SDK's height:100% empty state must not push the composer out. */}
              <div className="flex min-h-0 w-full flex-1 flex-col">
                <VisibleMessageList virtualized={shouldUseVirtualized} />
              </div>
              {isChatReadOnly ? (
                <div className="flex items-center justify-center gap-2 border-t border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>Chat is temporarily read-only during maintenance.</span>
                </div>
              ) : (
                <ComposerArea contextAppointmentId={contextAppointmentId} />
              )}
            </Window>
          </WithComponents>
        </Channel>
      </div>
    </StreamChatErrorBoundary>
  );
};
