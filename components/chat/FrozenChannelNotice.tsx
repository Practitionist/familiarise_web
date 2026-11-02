"use client";

import { LockIcon } from "lucide-react";

/**
 * Why there is no composer in a frozen conversation.
 *
 * Stream grants `use-frozen-channel` to no role, so a send into a frozen channel
 * fails without saying why. A direct message freezes after a long quiet spell and
 * reopens with the pair's next booking; an event channel closes after its session.
 */
export const FrozenChannelNotice = ({
  channelType,
}: {
  channelType: string;
}) => (
  <output className="flex items-center justify-center gap-2 border-t border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
    <LockIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
    <span>
      {channelType === "messaging"
        ? "This conversation is read-only. It reopens when you book a session together again."
        : "This channel is read-only. Its session has ended."}
    </span>
  </output>
);
