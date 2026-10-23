"use client";

import { ShieldCheckIcon } from "lucide-react";
import type { LocalMessage } from "stream-chat";
import { isSupportStreamUser } from "@/lib/stream/support-user";

interface SystemMessageProps {
  message: Pick<LocalMessage, "text" | "user">;
}

/**
 * A centred, muted line for `type: "system"` messages. The SDK routes system
 * messages to `MessageSystem`, so this is wired there and in CustomMessage.
 */
export const SystemMessage = ({ message }: SystemMessageProps) => {
  const text = message.text?.trim();
  if (!text) return null;

  const fromSupport = isSupportStreamUser(message.user?.id);

  return (
    <div className="my-3 flex justify-center px-4" data-testid="system-message">
      <p className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
        {fromSupport && (
          <ShieldCheckIcon
            className="h-3.5 w-3.5 shrink-0 text-info"
            aria-hidden="true"
          />
        )}
        <span>{text}</span>
      </p>
    </div>
  );
};
