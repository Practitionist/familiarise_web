"use client";

import { MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Channel,
  EmptyStateIndicator,
  MessageList,
  VirtualizedMessageList,
  Window,
  WithComponents,
  useChannelStateContext,
  useChatContext,
  type EmptyStateIndicatorProps,
} from "stream-chat-react";
import { AlertTriangle } from "lucide-react";
import { AppointmentDocumentsHint } from "./AppointmentDocumentsHint";
import { BookingTagComposer } from "./BookingTag";
import { ComposerDraftPersistence } from "./ComposerDraftPersistence";
import { CustomChannelHeader } from "./CustomChannelHeader";
import { CustomMessage } from "./CustomMessage";
import { SupportInterventionBanner } from "./SupportInterventionBanner";
import { SystemMessage } from "./SystemMessage";
import { StreamChatErrorBoundary } from "@/components/stream/StreamErrorBoundary";
import { useMaintenanceState } from "@/providers/MaintenanceProvider";
import { isEventChannel, parseEventChannelId } from "@/lib/stream-channel-ids";
import { EmptyState } from "@/components/dashboard/DataCard";

// Was a hand-rolled near-copy of EmptyState with different dimensions, on a
// `bg-zinc-50` slab pressed against the sidebar's blue. ChatUnavailable already
// used the shared one; this matches it.
const EmptyChannelState = () => (
  <div className="flex h-full w-full items-center justify-center bg-card p-8">
    <EmptyState
      icon={MessageSquareIcon}
      title="No conversation selected"
      description="Pick a conversation from the list to start chatting."
    />
  </div>
);

// An empty class or webinar channel invites the first message; DMs keep the SDK default.
const ChannelEmptyState = (props: EmptyStateIndicatorProps) => {
  const { channel } = useChannelStateContext();
  const event = parseEventChannelId(channel.id);
  if (!event || props.listType !== "message") {
    return <EmptyStateIndicator {...props} />;
  }
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      {event.eventType === "class"
        ? "Say hello to your class"
        : "Say hello to everyone in this webinar"}
    </div>
  );
};

// System messages bypass `Message` and render through `MessageSystem`.
// `uploads: false` still leaves the selector for commands/polls/location.
const AttachmentSelectorOff = () => null;
const CHAT_COMPONENT_OVERRIDES = {
  MessageSystem: SystemMessage,
  AttachmentSelector: AttachmentSelectorOff,
  EmptyStateIndicator: ChannelEmptyState,
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

  // Choose the appropriate MessageList component based on channel traffic
  const MessageListComponent = shouldUseVirtualized
    ? VirtualizedMessageList
    : MessageList;

  // For VirtualizedMessageList, we need to set defaultItemHeight for optimal performance
  const messageListProps = shouldUseVirtualized
    ? {
        Message: CustomMessage,
        defaultItemHeight: 62, // Typical height of a one-line message
        additionalVirtuosoProps: {
          // Additional performance optimizations
          increaseViewportBy: 200, // Render 200px outside viewport
          overscan: 5, // Keep 5 extra items rendered
        },
      }
    : { Message: CustomMessage };

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
              <MessageListComponent {...messageListProps} />
              {isChatReadOnly ? (
                <div className="flex items-center justify-center gap-2 border-t border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>Chat is temporarily read-only during maintenance.</span>
                </div>
              ) : (
                <>
                  <AppointmentDocumentsHint />
                  <ComposerDraftPersistence />
                  <BookingTagComposer
                    contextAppointmentId={contextAppointmentId}
                  />
                </>
              )}
            </Window>
          </WithComponents>
        </Channel>
      </div>
    </StreamChatErrorBoundary>
  );
};
