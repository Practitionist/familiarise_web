"use client";

import { tokenProvider } from "@/actions/stream/chat/stream.action";
import { upsertUserToStream } from "@/actions/stream/chat/user.action";
import { syncUserEventChannels } from "@/actions/stream/chat/event-channel.action";
import { useUserData } from "@/hooks/useUserData";
import { mapRoleToStream } from "@/lib/user";
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
  const [hasInitialSyncCompleted, setHasInitialSyncCompleted] = useState(false);
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
        console.log(`Upserting and connecting user ${userDetails.id} to Stream Chat`);
        
        // First, ensure the user exists in Stream's database
        try {
          await upsertUserToStream(userDetails.id);
          console.log(`User ${userDetails.id} successfully upserted to Stream`);
        } catch (upsertError) {
          console.warn("User upserting failed, but continuing with connection:", upsertError);
          // Continue with connection even if upserting fails
        }

        // Use the shared role mapping function
        const streamRole = mapRoleToStream(userDetails.role);

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
        console.log(`User ${userDetails.id} successfully connected to Stream Chat`);

        // Only sync channels on the very first connection, not on every reconnection
        if (!hasInitialSyncCompleted) {
          try {
            console.log(`Performing initial auto-sync of channels for user ${userDetails.id}`);
            await syncUserEventChannels(userDetails.id);
            console.log(`Successfully completed initial auto-sync for user ${userDetails.id}`);
            setHasInitialSyncCompleted(true);
          } catch (syncError) {
            console.warn(`Failed to auto-sync channels for user ${userDetails.id}:`, syncError);
            // Don't block the UI if channel sync fails, but don't mark as completed either
          }
        } else {
          console.log(`Skipping channel sync for user ${userDetails.id} - already completed initial sync`);
        }
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
  }, [apiKey, isLoading, userDetails, userId, hasInitialSyncCompleted]);

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
