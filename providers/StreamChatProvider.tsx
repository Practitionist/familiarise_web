"use client";

import { StreamChat } from "stream-chat";
import { Chat } from "stream-chat-react";
import { useEffect, useState } from "react";
import { useUserData } from "@/hooks/useUserData";
import { tokenProvider } from "@/actions/stream.action";

// Import Stream Chat CSS
import "stream-chat-react/dist/css/v2/index.css";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

type StreamChatProviderProps = {
  children: React.ReactNode;
  userId: string;
};

const StreamChatProvider = ({ children, userId }: StreamChatProviderProps) => {
  const [chatClient, setChatClient] = useState<StreamChat | null>(null);
  const { userDetails, isLoading } = useUserData(userId);

  useEffect(() => {
    if (isLoading) {
      console.info("User data is loading");
      return;
    }

    if (!userDetails) {
      console.warn("User not found");
      return;
    }

    if (!apiKey) {
      console.error("Stream API key not configured");
      return;
    }

    // Initialize the Stream Chat client
    const client = StreamChat.getInstance(apiKey);

    // Connect the user to Stream Chat
    const connectUser = async () => {
      try {
        await client.connectUser(
          {
            id: userDetails.id,
            name: userDetails.name ?? userDetails.id,
            image: userDetails.image ?? undefined,
            role: userDetails.role ?? "user",
          },
          async () => await tokenProvider(userId)
        );
        setChatClient(client);
      } catch (error) {
        console.error("Error connecting user to Stream Chat:", error);
      }
    };

    connectUser();

    // Cleanup function to disconnect the user when the component unmounts
    return () => {
      client.disconnectUser().then(() => {
        console.log("User disconnected from Stream Chat");
      });
    };
  }, [apiKey, isLoading, userDetails, userId]);

  if (!chatClient) {
    return (
      // Loading state
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <Chat client={chatClient}>{children}</Chat>;
};

export default StreamChatProvider;
