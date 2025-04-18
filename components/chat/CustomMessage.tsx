"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { format } from "date-fns";
import { useChatContext, useMessageContext } from "stream-chat-react";

export const CustomMessage = () => {
  const { message } = useMessageContext();
  const { client } = useChatContext();
  const isMyMessage = message.user?.id === client.userID;

  return (
    <div
      className={`flex ${isMyMessage ? "justify-end" : "justify-start"} mb-4`}
    >
      {!isMyMessage && (
        <Avatar className="mr-2">
          <AvatarImage src={message.user?.image} />
          <AvatarFallback>
            {message.user?.name?.charAt(0) || message.user?.id?.charAt(0)}
          </AvatarFallback>
        </Avatar>
      )}

      <div
        className={`max-w-[70%] ${isMyMessage ? "bg-blue-500 text-white" : "bg-gray-100"} rounded-lg px-4 py-2`}
      >
        {!isMyMessage && (
          <div className="font-semibold text-sm">
            {message.user?.name || message.user?.id}
          </div>
        )}
        <div>{message.text}</div>
        <div
          className={`text-xs mt-1 ${isMyMessage ? "text-blue-100" : "text-gray-500"}`}
        >
          {message.created_at && format(new Date(message.created_at), "h:mm a")}
        </div>
      </div>
    </div>
  );
};
