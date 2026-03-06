"use client";

import {
  useCallback,
  useEffect,
  useState,
  useRef,
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
import { streamLogger } from "@/lib/stream-logger";
import { initialSyncCompletedUsers } from "@/lib/stream-cache";
import StreamErrorBoundary from "@/components/stream/StreamErrorBoundary";

// Import Stream Chat CSS
import "stream-chat-react/dist/css/v2/index.css";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

// Module-level client instances to avoid re-creating on remount
let globalChatClient: StreamChat | null = null;
let globalVideoClient: StreamVideoClient | null = null;
let currentUserId: string | null = null;

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
  // Connection states - always initialize to null/false
  // Let the connection functions handle global client detection
  const [chatClient, setChatClient] = useState<StreamChat | null>(null);
  const [videoClient, setVideoClient] = useState<StreamVideoClient | null>(
    null,
  );
  const [chatConnected, setChatConnected] = useState(false);
  const [videoConnected, setVideoConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref for connection attempts to avoid stale closures in retry logic
  const connectionAttemptsRef = useRef(0);
  // Guard against concurrent connectUser calls (race: connectVideo resolves first,
  // triggers re-render + effect re-run before connectChat has set globalChatClient)
  const isChatConnectingRef = useRef(false);

  const { userDetails, isLoading } = useUserData(userId);

  // Token caching with expiry tracking — use ref to avoid triggering re-renders
  // (useState here caused getCachedToken → connectChat → connectServices to
  //  be recreated on every token fetch, making the connectUser useEffect fire
  //  repeatedly and producing "Consecutive calls to connectUser" warnings)
  const tokenCacheRef = useRef<{
    chatToken?: string;
    videoToken?: string;
    expiresAt?: number;
  }>({});

  const isTokenValid = useCallback((type: "chat" | "video") => {
    const cache = tokenCacheRef.current;
    const token = type === "chat" ? cache.chatToken : cache.videoToken;
    if (!token || !cache.expiresAt) return false;
    // Check if token expires within next 5 minutes
    return Date.now() < cache.expiresAt - 5 * 60 * 1000;
  }, []);

  const getCachedToken = useCallback(
    async (type: "chat" | "video"): Promise<string> => {
      if (isTokenValid(type)) {
        const cache = tokenCacheRef.current;
        return type === "chat" ? cache.chatToken! : cache.videoToken!;
      }

      // Generate new token
      const newToken =
        type === "chat"
          ? await chatTokenProvider(userId)
          : await tokenProvider(userId);

      // Cache with 50-minute expiry (tokens usually last 1 hour)
      tokenCacheRef.current = {
        ...tokenCacheRef.current,
        [`${type}Token`]: newToken,
        expiresAt: Date.now() + 50 * 60 * 1000,
      };

      return newToken;
    },
    [userId, isTokenValid],
  );

  // Exponential backoff retry logic
  const getRetryDelay = useCallback((attempt: number) => {
    return Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
  }, []);

  const connectChat = useCallback(async () => {
    if (!enableChat || !userDetails || !apiKey) return;

    // Check if we already have a global client for this user - adopt it
    if (currentUserId === userDetails.id && globalChatClient) {
      streamLogger.debug("Adopting existing chat client", {
        userId: userDetails.id,
      });
      setChatClient(globalChatClient);
      setChatConnected(true);
      return;
    }

    // Prevent concurrent connectUser calls (e.g. connectVideo re-render race)
    if (isChatConnectingRef.current) {
      streamLogger.debug("Chat connection already in progress, skipping", {
        userId: userDetails.id,
      });
      return;
    }

    isChatConnectingRef.current = true;

    try {
      streamLogger.debug("Connecting to Stream Chat", {
        userId: userDetails.id,
      });

      const client = StreamChat.getInstance(apiKey);

      // If the singleton is already connected to this user (e.g. StreamVideoClient
      // connected it internally), adopt it directly without calling connectUser again.
      if (client.userID && client.userID === userDetails.id) {
        streamLogger.debug("Adopting already-connected Stream Chat singleton", {
          userId: userDetails.id,
        });
        globalChatClient = client;
        currentUserId = userDetails.id;
        setChatClient(client);
        setChatConnected(true);
        return;
      }

      // Ensure user exists in Stream's database (only if not synced before)
      if (!initialSyncCompletedUsers.has(userDetails.id)) {
        try {
          await upsertUserToStream(userDetails.id);
          streamLogger.debug("User upserted to Stream", {
            userId: userDetails.id,
          });
        } catch (upsertError) {
          streamLogger.warn("User upsert failed, continuing", {
            userId: userDetails.id,
          });
        }
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

      // Store in global references
      globalChatClient = client;
      currentUserId = userDetails.id;

      setChatClient(client);
      setChatConnected(true);

      // Initial channel sync only once per user per session
      if (!initialSyncCompletedUsers.has(userDetails.id)) {
        try {
          streamLogger.info("Starting initial channel sync", {
            userId: userDetails.id,
          });
          await syncUserEventChannels(userDetails.id);
          initialSyncCompletedUsers.add(userDetails.id);
          streamLogger.info("Initial channel sync completed", {
            userId: userDetails.id,
          });
        } catch (syncError) {
          streamLogger.warn("Channel sync failed", { userId: userDetails.id });
          // Still mark as completed to avoid repeated failed attempts
          initialSyncCompletedUsers.add(userDetails.id);
        }
      } else {
        streamLogger.debug("Skipping channel sync (already completed)", {
          userId: userDetails.id,
        });
      }

      streamLogger.info("Chat connection established", {
        userId: userDetails.id,
      });
    } catch (error) {
      streamLogger.warn("Chat connection failed (will retry)", {
        userId: userDetails.id,
      });
      setChatConnected(false);
      throw error;
    } finally {
      isChatConnectingRef.current = false;
    }
  }, [enableChat, userDetails, apiKey, getCachedToken]);

  const connectVideo = useCallback(async () => {
    if (!enableVideo || !userDetails || !apiKey) return;

    // Check if we already have a global client for this user - adopt it
    if (currentUserId === userDetails.id && globalVideoClient) {
      streamLogger.debug("Adopting existing video client", {
        userId: userDetails.id,
      });
      setVideoClient(globalVideoClient);
      setVideoConnected(true);
      return;
    }

    try {
      streamLogger.debug("Connecting to Stream Video", {
        userId: userDetails.id,
      });

      const client = new StreamVideoClient({
        apiKey: apiKey,
        user: {
          id: userDetails.id,
          name: userDetails.name ?? userDetails.id,
          image: userDetails.image ?? undefined,
        },
        tokenProvider: () => getCachedToken("video"),
      });

      // Store in global reference
      globalVideoClient = client;
      currentUserId = userDetails.id;

      setVideoClient(client);
      setVideoConnected(true);
      streamLogger.info("Video connection established", {
        userId: userDetails.id,
      });
    } catch (error) {
      streamLogger.error("Video connection failed", error, {
        userId: userDetails.id,
      });
      setVideoConnected(false);
      throw error;
    }
  }, [enableVideo, userDetails, apiKey, getCachedToken]);

  // Full disconnect - only call when user changes or app unmounts
  const disconnect = useCallback(
    async (clearGlobal = false) => {
      const promises = [];

      if (chatClient) {
        promises.push(
          chatClient.disconnectUser().then(() => {
            streamLogger.debug("Chat client disconnected");
            setChatClient(null);
            setChatConnected(false);
            if (clearGlobal) {
              globalChatClient = null;
            }
          }),
        );
      }

      if (videoClient) {
        // Note: StreamVideoClient doesn't have explicit disconnect method
        // It's cleaned up when the component unmounts
        setVideoClient(null);
        setVideoConnected(false);
        if (clearGlobal) {
          globalVideoClient = null;
        }
      }

      await Promise.all(promises);
      if (clearGlobal) {
        currentUserId = null;
        tokenCacheRef.current = {}; // Clear token cache
        connectionAttemptsRef.current = 0; // Reset attempts
      }
    },
    [chatClient, videoClient],
  );

  // Stable connectServices function using ref pattern for retry logic
  const connectServices = useCallback(async () => {
    if (isLoading || !userDetails) return;

    setIsConnecting(true);
    setError(null);

    try {
      const promises = [];
      // Always try to connect - the functions will handle global client detection
      if (enableChat) promises.push(connectChat());
      if (enableVideo) promises.push(connectVideo());

      await Promise.all(promises);
      connectionAttemptsRef.current = 0; // Reset on success
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Connection failed";
      setError(errorMessage);

      // Implement exponential backoff retry using ref
      connectionAttemptsRef.current += 1;
      const currentAttempts = connectionAttemptsRef.current;

      if (currentAttempts < 5) {
        // Max 5 attempts
        const delay = getRetryDelay(currentAttempts);
        streamLogger.debug(`Retrying connection in ${delay}ms`, {
          attempt: currentAttempts,
        });
        setTimeout(() => {
          setIsConnecting(false);
          // Re-run connection (the ref ensures we get current attempt count)
          connectServices();
        }, delay);
        return;
      } else {
        streamLogger.error("Max connection attempts reached", error);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [
    isLoading,
    userDetails,
    enableChat,
    enableVideo,
    connectChat,
    connectVideo,
    getRetryDelay,
  ]);

  const retryConnection = useCallback(() => {
    connectionAttemptsRef.current = 0;
    setError(null);
    connectServices();
  }, [connectServices]);

  // Initialize connections
  useEffect(() => {
    if (!isLoading && userDetails && apiKey) {
      // Check if user changed - if so, disconnect old user first
      if (currentUserId && currentUserId !== userDetails.id) {
        streamLogger.info("User changed, reconnecting", {
          from: currentUserId,
          to: userDetails.id,
        });
        disconnect(true).then(() => {
          connectServices();
        });
      } else {
        connectServices();
      }
    }

    // Don't disconnect on unmount - keep global clients alive for tab switching
    // Only disconnect when user explicitly logs out or changes
    return () => {
      // Intentionally not calling disconnect() here
      // Global clients are reused across component remounts
    };
  }, [userDetails?.id, isLoading, apiKey, connectServices, disconnect]);

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
  if (error && connectionAttemptsRef.current >= 5) {
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
        streamLogger.error("Stream Provider Error", error, {
          componentStack: errorInfo.componentStack,
        });
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
