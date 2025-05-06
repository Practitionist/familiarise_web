"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { format } from "date-fns";
import {
  Attachment,
  useChatContext,
  useMessageContext,
} from "stream-chat-react";

export const CustomMessage = () => {
  const { message } = useMessageContext();
  const { client } = useChatContext();
  const isMyMessage = message.user?.id === client.userID;

  // Check if the message has text content
  const hasText = !!message.text?.trim();
  // Check if the message has attachments
  const hasAttachments =
    !!message.attachments && message.attachments.length > 0;

  // Avoid rendering empty messages (e.g., deleted messages with no text/attachments)
  if (!hasText && !hasAttachments && !message.customType) {
    // Allow rendering custom event messages even if they lack text/attachments
    return null;
  }

  return (
    <div
      className={`flex items-end ${isMyMessage ? "justify-end" : "justify-start"} mb-4 group`}
    >
      {/* Avatar for other users' messages */}
      {!isMyMessage && (
        <Avatar className="mr-2 w-8 h-8 flex-shrink-0">
          {" "}
          {/* Adjusted size */}
          <AvatarImage src={message.user?.image} />
          <AvatarFallback>
            {message.user?.name?.charAt(0) ??
              message.user?.id?.charAt(0) ??
              "?"}
          </AvatarFallback>
        </Avatar>
      )}

      {/* Message Bubble */}
      <div
        className={`max-w-[70%] ${isMyMessage ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-800"} rounded-lg px-3 py-2`}
      >
        {/* User Name for other users' messages */}
        {!isMyMessage && (
          <div className="font-semibold text-sm mb-1">
            {message.user?.name ?? message.user?.id}
          </div>
        )}

        {/* Render Attachments if they exist */}
        {hasAttachments && (
          // Use Stream's recommended class structure for potential styling hooks
          <div
            className={`attachments mb-1 ${hasText ? "mb-1" : ""} grid gap-2`}
          >
            {message.attachments?.map((attachment, index) => (
              <div
                key={`${message.id}-attachment-${index}`}
                className="attachment-item"
              >
                {/* Use Stream's Attachment component, passing the single attachment in an array */}
                <Attachment attachments={[attachment]} />
              </div>
            ))}
          </div>
        )}

        {/* Render Text if it exists */}
        {hasText && (
          <div className="message-text break-words">{message.text}</div>
        )}

        {/* Timestamp - Conditionally shown or shown on hover for cleaner UI */}
        <div
          className={`text-xs mt-1 text-right ${isMyMessage ? "text-blue-100 opacity-80" : "text-gray-500"} transition-opacity opacity-0 group-hover:opacity-100`}
        >
          {message.created_at && format(new Date(message.created_at), "p")}{" "}
          {/* 'p' for localized time */}
        </div>
      </div>
    </div>
  );
};
