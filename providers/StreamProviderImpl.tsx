"use client";

// Heavy Stream SDK implementation. This module is ONLY loaded via next/dynamic
// from StreamProvider.tsx (ssr:false). Keeping every Stream SDK import + the two
// SDK stylesheets in a separate module is what actually code-splits the SDK out
// of the synchronous bundle of every route that mounts <StreamProvider>. #248
//
// NOTE (flagged to reviewer): this file is outside the originally-scoped edit
// set, but a real next/dynamic split is impossible without a separate module —
// dynamic()-wrapping a component defined in the same file does not code-split,
// since its static imports stay in the parent chunk. See StreamProvider.tsx.

import {
  useCallback,
  useEffect,
  useState,
  useRef,
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
import StreamErrorBoundary from "@/components/stream/StreamErrorBoundary";
import {
  StreamConnectionContext,
  type StreamConnectionState,
  type StreamProviderProps,
} from "@/providers/StreamProvider";
// Shared module-level client refs now live in an SDK-free module so SDK-free
// callers can disconnect on logout without linking the Stream SDK. #248
import {
  getGlobalChatClient,
  setGlobalChatClient,
  getGlobalVideoClient,
  setGlobalVideoClient,
  getCurrentStreamUserId,
  setCurrentStreamUserId,
  disconnectStreamClients,
} from "@/lib/stream/disconnect";

// Stream CSS co-located with the heavy impl so the ~2 stylesheets ship only
// inside this lazy chunk (was previously imported at provider module top-level
// and by both dashboard layouts).
import "stream-chat-react/dist/css/v2/index.css";
import "@stream-io/video-react-sdk/dist/css/styles.css";

// Client-side only: tracks which users have completed initial sync within this
// browser tab's module lifecycle. Separate from the server-side Set in stream-cache.ts.
const clientSyncCompletedUsers = new Set<string>();

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

const StreamProviderImpl = ({
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
  // We need BOTH a ref and state for retry count: the ref (connectionAttemptsRef)
  // is used inside setTimeout/async closures where state would be stale, while
  // this state variable drives re-renders so the UI shows the correct attempt count.
  const [retryCount, setRetryCount] = useState(0);

  // Use ref for connection attempts to avoid stale closures in retry logic
  const connectionAttemptsRef = useRef(0);
  // Guard against concurrent connectUser calls (race: connectVideo resolves first,
  // triggers re-render + effect re-run before connectChat has set globalChatClient)
  const isChatConnectingRef = useRef(false);
  // Track retry timeout so we can cancel on unmount
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const { userDetails, isLoading } = useUserData(userId);

  // Token caching with expiry tracking — use ref to avoid triggering re-renders
  // (useState here caused getCachedToken → connectChat → connectServices to
  //  be recreated on every token fetch, making the connectUser useEffect fire
  //  repeatedly and producing "Consecutive calls to connectUser" warnings)
  // Each token type has its own expiry to avoid one overwriting the other's validity window.
  const tokenCacheRef = useRef<{
    chatToken?: string;
    chatExpiresAt?: number;
    videoToken?: string;
    videoExpiresAt?: number;
  }>({});

  const isTokenValid = useCallback((type: "chat" | "video") => {
    const cache = tokenCacheRef.current;
    const token = type === "chat" ? cache.chatToken : cache.videoToken;
    const expiresAt =
      type === "chat" ? cache.chatExpiresAt : cache.videoExpiresAt;
    if (!token || !expiresAt) return false;
    // Check if token expires within next 5 minutes
    return Date.now() < expiresAt - 5 * 60 * 1000;
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
      const expiresAt = Date.now() + 50 * 60 * 1000;
      if (type === "chat") {
        tokenCacheRef.current.chatToken = newToken;
        tokenCacheRef.current.chatExpiresAt = expiresAt;
      } else {
        tokenCacheRef.current.videoToken = newToken;
        tokenCacheRef.current.videoExpiresAt = expiresAt;
      }

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
    if (getCurrentStreamUserId() === userDetails.id && getGlobalChatClient()) {
      streamLogger.debug("Adopting existing chat client", {
        userId: userDetails.id,
      });
      setChatClient(getGlobalChatClient());
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
        setGlobalChatClient(client);
        setCurrentStreamUserId(userDetails.id);
        setChatClient(client);
        setChatConnected(true);
        return;
      }

      // Ensure user exists in Stream's database (only if not synced before)
      if (!clientSyncCompletedUsers.has(userDetails.id)) {
        try {
          await upsertUserToStream(userDetails.id);
          streamLogger.debug("User upserted to Stream", {
            userId: userDetails.id,
          });
        } catch (upsertError) {
          streamLogger.warn("User upsert failed, continuing", {
            userId: userDetails.id,
            error: upsertError,
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
      setGlobalChatClient(client);
      setCurrentStreamUserId(userDetails.id);

      setChatClient(client);
      setChatConnected(true);

      // Initial channel sync — once per user per browser session.
      // The in-memory Set resets on page reload (client module re-evaluation),
      // so we persist to sessionStorage to survive refreshes within the same tab.
      const syncKey = `stream_sync_${userDetails.id}`;
      const alreadySynced =
        clientSyncCompletedUsers.has(userDetails.id) ||
        (typeof sessionStorage !== "undefined" &&
          sessionStorage.getItem(syncKey) === "1");

      if (!alreadySynced) {
        try {
          streamLogger.info("Starting initial channel sync", {
            userId: userDetails.id,
          });
          await syncUserEventChannels(userDetails.id);
          clientSyncCompletedUsers.add(userDetails.id);
          if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem(syncKey, "1");
          }
          streamLogger.info("Initial channel sync completed", {
            userId: userDetails.id,
          });
        } catch (syncError) {
          streamLogger.warn("Channel sync failed", {
            userId: userDetails.id,
            error: syncError,
          });
          // Mark in-memory to avoid retry within same component lifecycle,
          // but don't persist to sessionStorage so next load retries.
          clientSyncCompletedUsers.add(userDetails.id);
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
  }, [enableChat, userDetails, getCachedToken]);

  const connectVideo = useCallback(async () => {
    if (!enableVideo || !userDetails || !apiKey) return;

    // Check if we already have a global client for this user - adopt it
    if (getCurrentStreamUserId() === userDetails.id && getGlobalVideoClient()) {
      streamLogger.debug("Adopting existing video client", {
        userId: userDetails.id,
      });
      setVideoClient(getGlobalVideoClient());
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
      setGlobalVideoClient(client);
      setCurrentStreamUserId(userDetails.id);

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
  }, [enableVideo, userDetails, getCachedToken]);

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
      setRetryCount(0);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Connection failed";
      setError(errorMessage);

      // Implement exponential backoff retry using ref
      connectionAttemptsRef.current += 1;
      setRetryCount(connectionAttemptsRef.current); // Sync state for UI display
      const currentAttempts = connectionAttemptsRef.current;

      if (currentAttempts < 5) {
        // Max 5 attempts
        const delay = getRetryDelay(currentAttempts);
        streamLogger.debug(`Retrying connection in ${delay}ms`, {
          attempt: currentAttempts,
        });
        setIsConnecting(false);
        retryTimeoutRef.current = setTimeout(() => {
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

  // Initialize connections.
  // connectServices is in deps and may cause re-fires when its useCallback
  // identity changes, but this is safe because:
  // - connectChat guards with globalChatClient + currentUserId check (no-op if already connected)
  // - syncUserEventChannels is guarded by sessionStorage (no-op after first sync)
  //
  // #248: this impl is only mounted via next/dynamic, so the SDK + this connect
  // logic are already deferred off the home critical path. We additionally
  // schedule the initial connect in requestIdleCallback (with a setTimeout
  // fallback) so the connect-storm (connectUser + syncUserEventChannels) doesn't
  // compete with first paint of whatever dashboard route mounted the provider.
  useEffect(() => {
    if (!(!isLoading && userDetails && apiKey)) {
      return;
    }

    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      // Check if user changed - if so, disconnect old user first.
      // Use disconnectStreamClients (global refs) rather than the local
      // disconnect() here: on a fresh remount for a different user, local
      // chatClient/videoClient state is null while the GLOBAL clients still
      // point at the PREVIOUS user. local disconnect() would no-op and leak
      // the prior user's connection, which the new connect would then adopt.
      if (
        getCurrentStreamUserId() &&
        getCurrentStreamUserId() !== userDetails.id
      ) {
        streamLogger.info("User changed, reconnecting", {
          from: getCurrentStreamUserId(),
          to: userDetails.id,
        });
        // Reset local token cache + attempt counter so the new user connects
        // with fresh tokens (disconnectStreamClients owns the global teardown).
        tokenCacheRef.current = {};
        connectionAttemptsRef.current = 0;
        disconnectStreamClients()
          .catch((err) => {
            // Never block the new user's connect on a prior-user disconnect
            // failure; disconnectStreamClients already clears global refs.
            streamLogger.warn("Prior-user disconnect failed, connecting anyway", {
              error: err,
            });
          })
          .then(() => {
            connectServices();
          });
      } else {
        connectServices();
      }
    };

    // Defer the connect off the critical path (#248).
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = (
        window as Window & {
          requestIdleCallback: (
            cb: () => void,
            opts?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback(run, { timeout: 2000 });
    } else {
      timeoutHandle = setTimeout(run, 0);
    }

    // Don't disconnect on unmount - keep global clients alive for tab switching
    // Only disconnect when user explicitly logs out or changes
    return () => {
      // Cancel pending scheduled connect + any pending retry timeout to avoid
      // state updates after unmount.
      if (
        idleHandle !== undefined &&
        typeof window !== "undefined" &&
        "cancelIdleCallback" in window
      ) {
        (
          window as Window & {
            cancelIdleCallback: (handle: number) => void;
          }
        ).cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = undefined;
      }
      // Intentionally not calling disconnect() here
      // Global clients are reused across component remounts
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userDetails?.id, isLoading, connectServices]);

  // Connection state for context
  const connectionState: StreamConnectionState = {
    chatConnected,
    videoConnected,
    isConnecting,
    error,
    retryConnection,
  };

  // #248: do NOT block children render on connection. Previously this returned
  // a full-screen spinner until both clients connected, which gated the entire
  // dashboard route (incl. home) behind the Stream connect-storm. We now always
  // render children immediately; the Stream context providers wrap them once the
  // clients are ready, and the video/chat consumers already guard a null client.

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

  // The connection-failed banner renders alongside children (not in place of
  // them) so the underlying route stays usable while Stream retries/recovers.
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
        {error && retryCount >= 5 && (
          <div className="flex flex-col items-center justify-center p-4">
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
        )}
        {content}
      </StreamConnectionContext.Provider>
    </StreamErrorBoundary>
  );
};

export default StreamProviderImpl;
