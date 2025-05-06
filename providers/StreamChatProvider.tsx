"use client";

import { tokenProvider } from "@/actions/stream/chat/stream.action";
import { useUserData } from "@/hooks/useUserData";
import { useEffect, useState } from "react";
import { StreamChat } from "stream-chat";
import { Chat } from "stream-chat-react";

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
        // Map our application roles to Stream Chat roles
        // Stream Chat roles are: admin, user, guest, anonymous
        let streamRole = "user"; // Default role

        if (userDetails.role) {
          // Map our application roles to Stream Chat roles
          switch (userDetails.role.toUpperCase()) {
            case "ADMIN":
              streamRole = "admin";
              break;
            case "CONSULTANT":
            case "CONSULTEE":
            case "USER":
              streamRole = "user";
              break;
            default:
              streamRole = "user";
          }
        }

        console.log(
          `Connecting user ${userDetails.id} with role ${streamRole}`,
        );

        await client.connectUser(
          {
            id: userDetails.id,
            name: userDetails.name ?? userDetails.id,
            image: userDetails.image ?? undefined,
            role: streamRole,
          },
          async () => await tokenProvider(userId),
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
