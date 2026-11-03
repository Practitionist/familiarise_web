"use client";

import { ShieldCheckIcon } from "lucide-react";
import { useChannelStateContext } from "stream-chat-react";
import { MESSAGE_REVIEW_ARTICLE_HREF } from "@/lib/compliance/purpose-codes";
import { membersIncludeSupport } from "./utils/channelUtils";

/**
 * Shown while Familiarise Support is a member of the open channel. Presence is
 * membership only; the context's `members` refreshes on member.added/removed.
 */
export const SupportInterventionBanner = () => {
  const { channel, members } = useChannelStateContext(
    "SupportInterventionBanner",
  );

  if (!membersIncludeSupport(members ?? channel?.state?.members)) return null;

  return (
    <output className="flex items-center justify-center gap-2 border-b border-info/40 bg-info/10 px-4 py-3 text-sm text-foreground">
      <ShieldCheckIcon
        className="h-4 w-4 shrink-0 text-info"
        aria-hidden="true"
      />
      <span>
        Familiarise Support is in this chat to help with a reported issue. Our
        team can read this conversation while the issue is open.{" "}
        <a
          href={MESSAGE_REVIEW_ARTICLE_HREF}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline underline-offset-4 hover:no-underline"
        >
          How we review messages
        </a>
      </span>
    </output>
  );
};
