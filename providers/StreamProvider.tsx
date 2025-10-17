"use client";

import {
  useCallback,
  useEffect,
  useState,
  createContext,
  useContext,
} from "react";
import { StreamChat } from "stream-chat";
import { Chat } from "stream-chat-react";
import { StreamVideo, StreamVideoClient } from "@stream-io/video-react-sdk";
import {
  chatTokenProvider,
  tokenProvider,
} from "@/actions/stream/chat/stream.action";
import { upsertUserToStream } from "@/actions/stream/chat/user.action";
import { syncUserEventChannels } from "@/actions/stream/chat/event-channel.action";
import { useUserData } from "@/hooks/useUserData";
import { mapRoleToStream } from "@/lib/user";
import StreamErrorBoundary from "@/components/stream/StreamErrorBoundary";

// Import Stream Chat CSS
import "stream-chat-react/dist/css/v2/index.css";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

// Connection state context
interface StreamConnectionState {
  chatConnected: boolean;
  videoConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  retryConnection: () => void;
}

const StreamConnectionContext = createContext<StreamConnectionState | null>(
  null,
);

export const useStreamConnection = () => {
  const context = useContext(StreamConnectionContext);
  if (!context) {
    throw new Error("useStreamConnection must be used within StreamProvider");
  }
  return context;
};

interface StreamProviderProps {
  children: React.ReactNode;
  userId: string;
  enableChat?: boolean;
  enableVideo?: boolean;
}

const StreamProvider = ({
  children,
  userId,
  enableChat = true,
  enableVideo = true,
}: StreamProviderProps) => {
  // Connection states
  const [chatClient, setChatClient] = useState<StreamChat | null>(null);
  const [videoClient, setVideoClient] = useState<StreamVideoClient | null>(
    null,
  );
  const [chatConnected, setChatConnected] = useState(false);
  const [videoConnected, setVideoConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInitialSyncCompleted, setHasInitialSyncCompleted] = useState(false);
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  const { userDetails, isLoading } = useUserData(userId);

  // Enhanced token caching
  const [tokenCache, setTokenCache] = useState<{
    chatToken?: string;
    videoToken?: string;
    expiresAt?: number;
  }>({});

  const isTokenValid = useCallback(
    (type: "chat" | "video") => {
      const token =
        type === "chat" ? tokenCache.chatToken : tokenCache.videoToken;
      const expiresAt = tokenCache.expiresAt;

      if (!token || !expiresAt) return false;

      // Check if token expires within next 5 minutes
      return Date.now() < expiresAt - 5 * 60 * 1000;
    },
    [tokenCache],
  );

  const getCachedToken = useCallback(
    async (type: "chat" | "video"): Promise<string> => {
      if (isTokenValid(type)) {
        return type === "chat" ? tokenCache.chatToken! : tokenCache.videoToken!;
      }

      // Generate new token
      const newToken =
        type === "chat"
          ? await chatTokenProvider(userId)
          : await tokenProvider(userId);

      // Cache with 50-minute expiry (tokens usually last 1 hour)
      const expiresAt = Date.now() + 50 * 60 * 1000;

      setTokenCache((prev) => ({
        ...prev,
        [`${type}Token`]: newToken,
        expiresAt,
      }));

      return newToken;
    },
    [userId, tokenCache, isTokenValid],
  );

  // Exponential backoff retry logic
  const getRetryDelay = useCallback((attempt: number) => {
    return Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
  }, []);

  const connectChat = useCallback(async () => {
    if (!enableChat || !userDetails || !apiKey || chatConnected) return;

    try {
      console.log(`Connecting user ${userDetails.id} to Stream Chat`);

      const client = StreamChat.getInstance(apiKey);

      // Ensure user exists in Stream's database
      try {
        await upsertUserToStream(userDetails.id);
        console.log(`User ${userDetails.id} upserted to Stream`);
      } catch (upsertError) {
        console.warn("User upserting failed, continuing:", upsertError);
      }

      const streamRole = mapRoleToStream(userDetails.role);

      await client.connectUser(
        {
          id: userDetails.id,
          name: userDetails.name ?? userDetails.id,
          image: userDetails.image ?? undefined,
          role: streamRole,
        },
        () => getCachedToken("chat"),
      );

      setChatClient(client);
      setChatConnected(true);

      // Initial channel sync only once
      if (!hasInitialSyncCompleted) {
        try {
          console.log(
            `Performing initial channel sync for user ${userDetails.id}`,
          );
          await syncUserEventChannels(userDetails.id);
          setHasInitialSyncCompleted(true);
          console.log(`Completed initial sync for user ${userDetails.id}`);
        } catch (syncError) {
          console.warn(
            `Channel sync failed for user ${userDetails.id}:`,
            syncError,
          );
        }
      }

      console.log(`Chat connection successful for user ${userDetails.id}`);
    } catch (error) {
      console.error("Chat connection failed:", error);
      setChatConnected(false);
      throw error;
    }
  }, [
    enableChat,
    userDetails,
    apiKey,
    chatConnected,
    hasInitialSyncCompleted,
    getCachedToken,
  ]);

  const connectVideo = useCallback(async () => {
    if (!enableVideo || !userDetails || !apiKey || videoConnected) return;

    try {
      console.log(`Connecting user ${userDetails.id} to Stream Video`);

      const client = new StreamVideoClient({
        apiKey: apiKey,
        user: {
          id: userDetails.id,
          name: userDetails.name ?? userDetails.id,
          image: userDetails.image ?? undefined,
        },
        tokenProvider: () => getCachedToken("video"),
      });

      setVideoClient(client);
      setVideoConnected(true);
      console.log(`Video connection successful for user ${userDetails.id}`);
    } catch (error) {
      console.error("Video connection failed:", error);
      setVideoConnected(false);
      throw error;
    }
  }, [enableVideo, userDetails, apiKey, videoConnected, getCachedToken]);

  const connectServices = useCallback(async () => {
    if (isLoading || !userDetails || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const promises = [];
      if (enableChat && !chatConnected) promises.push(connectChat());
      if (enableVideo && !videoConnected) promises.push(connectVideo());

      await Promise.all(promises);
      setConnectionAttempts(0); // Reset on success
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Connection failed";
      setError(errorMessage);

      // Implement exponential backoff retry
      const newAttempts = connectionAttempts + 1;
      setConnectionAttempts(newAttempts);

      if (newAttempts < 5) {
        // Max 5 attempts
        const delay = getRetryDelay(newAttempts);
        console.log(
          `Retrying connection in ${delay}ms (attempt ${newAttempts})`,
        );
        setTimeout(() => {
          setIsConnecting(false);
          connectServices();
        }, delay);
        return;
      } else {
        console.error("Max connection attempts reached");
      }
    } finally {
      setIsConnecting(false);
    }
  }, [
    isLoading,
    userDetails,
    isConnecting,
    enableChat,
    enableVideo,
    chatConnected,
    videoConnected,
    connectChat,
    connectVideo,
    connectionAttempts,
    getRetryDelay,
  ]);

  const retryConnection = useCallback(() => {
    setConnectionAttempts(0);
    setError(null);
    connectServices();
  }, [connectServices]);

  const disconnect = useCallback(async () => {
    const promises = [];

    if (chatClient) {
      promises.push(
        chatClient.disconnectUser().then(() => {
          console.log("Chat client disconnected");
          setChatClient(null);
          setChatConnected(false);
        }),
      );
    }

    if (videoClient) {
      // Note: StreamVideoClient doesn't have explicit disconnect method
      // It's cleaned up when the component unmounts
      setVideoClient(null);
      setVideoConnected(false);
    }

    await Promise.all(promises);
    setTokenCache({}); // Clear token cache
  }, [chatClient, videoClient]);

  // Initialize connections
  useEffect(() => {
    if (!isLoading && userDetails && apiKey) {
      connectServices();
    }

    return () => {
      disconnect();
    };
  }, [userDetails, isLoading, apiKey]); // Removed connectServices and disconnect to avoid infinite loops

  // Connection state for context
  const connectionState: StreamConnectionState = {
    chatConnected,
    videoConnected,
    isConnecting,
    error,
    retryConnection,
  };

  // Loading state
  if (
    (enableChat && !chatClient && !error) ||
    (enableVideo && !videoClient && !error) ||
    isConnecting
  ) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
        {isConnecting && (
          <p className="ml-4 text-sm text-gray-600">Connecting to Stream...</p>
        )}
      </div>
    );
  }

  // Error state
  if (error && connectionAttempts >= 5) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[200px] p-4">
        <div className="text-red-600 text-center">
          <h3 className="font-semibold mb-2">Connection Failed</h3>
          <p className="text-sm mb-4">{error}</p>
          <button
            onClick={retryConnection}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  // Render providers
  let content = children;

  // Wrap with video provider if enabled and connected
  if (enableVideo && videoClient) {
    content = <StreamVideo client={videoClient}>{content}</StreamVideo>;
  }

  // Wrap with chat provider if enabled and connected
  if (enableChat && chatClient) {
    content = <Chat client={chatClient}>{content}</Chat>;
  }

  return (
    <StreamErrorBoundary
      onError={(error, errorInfo) => {
        console.error("Stream Provider Error:", error, errorInfo);
        setError(error.message);
      }}
      enableRetry={true}
    >
      <StreamConnectionContext.Provider value={connectionState}>
        {content}
      </StreamConnectionContext.Provider>
    </StreamErrorBoundary>
  );
};

export default StreamProvider;
