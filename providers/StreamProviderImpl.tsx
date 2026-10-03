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

import { useCallback, useEffect, useState, useRef } from "react";
import { StreamChat } from "stream-chat";
import { StreamVideoClient } from "@stream-io/video-react-sdk";
import {
  chatTokenProvider,
  tokenProvider,
} from "@/actions/stream/chat/stream.action";
import { upsertUserToStream } from "@/actions/stream/chat/user.action";
import { syncUserEventChannels } from "@/actions/stream/chat/event-channel.action";
import { useUserData } from "@/hooks/useUserData";
import { useSession } from "@/lib/auth-client";
import { mapRoleToStream } from "@/lib/user";
import { streamLogger } from "@/lib/stream-logger";
import { setStreamConnection } from "@/lib/stream/connection-store";
import {
  classifyConnectFailure,
  type ConnectFailure,
} from "@/lib/stream/connect-failure";
import { refusalFromShape } from "@/lib/errors/client-refusal";
import { isRefusal, type Refusal } from "@/lib/errors/refusal";
import { STREAM_TOKEN_CACHE_MS } from "@/lib/stream/token-ttl";
import { seedFromInitialTokens } from "@/lib/stream/seed-token-cache";
import { useStreamInitialTokens } from "@/components/stream/StreamInitialTokens";
import * as Sentry from "@sentry/nextjs";

/** Backoff attempts for a RETRYABLE connect failure; a non-retryable one stops at 1. */
const MAX_CONNECT_ATTEMPTS = 5;

/** Grace period before app-level reconnect kicks in after a continuous offline state. */
const RECONNECT_GRACE_MS = 8_000;

const settled = <T,>(result: PromiseSettledResult<T>): T | null =>
  result.status === "fulfilled" ? result.value : null;

type ChatLiveness = {
  wsConnection: Pick<
    NonNullable<StreamChat["wsConnection"]>,
    "isHealthy" | "connectionID"
  > | null;
  wsFallback?: Pick<
    NonNullable<StreamChat["wsFallback"]>,
    "isHealthy" | "connectionID"
  >;
  _hasConnectionID: StreamChat["_hasConnectionID"];
};

export function isChatClientLive(client: ChatLiveness): boolean {
  const wsHealthy = client.wsConnection?.isHealthy === true;
  const fallbackHealthy = client.wsFallback?.isHealthy() === true;
  return (wsHealthy || fallbackHealthy) && client._hasConnectionID();
}

type VideoLiveness = {
  streamClient: {
    wsConnection: Pick<
      NonNullable<StreamVideoClient["streamClient"]["wsConnection"]>,
      "isHealthy" | "connectionID"
    > | null;
    _hasConnectionID: StreamVideoClient["streamClient"]["_hasConnectionID"];
  };
};

export function isVideoClientLive(client: VideoLiveness): boolean {
  const coordinator = client.streamClient;
  return (
    coordinator.wsConnection?.isHealthy === true &&
    coordinator._hasConnectionID()
  );
}

/**
 * The token action answered "no session" — a state to show, not an outage to
 * retry or report. Shaped like a Stream failure so ChatUnavailable renders it.
 */
function refusedConnectFailure(refusal: Refusal): ConnectFailure {
  return {
    kind: "not-retryable",
    code: null,
    detail: refusal.devMessage,
    title: "Please sign in again",
    description: refusal.userMessage,
    action: "reload",
  };
}

/**
 * One Sentry event per non-retryable connect outcome — `warning` for an
 * account state, `error` otherwise — with a stable fingerprint so a disabled
 * account groups into one issue instead of one per page load.
 */
function reportNonRetryableConnectFailure(
  error: unknown,
  classified: ConnectFailure,
): void {
  if (process.env.NODE_ENV === "development") return;
  Sentry.captureException(
    error instanceof Error ? error : new Error(classified.detail),
    {
      level: classified.kind === "account-disabled" ? "warning" : "error",
      fingerprint: [
        "stream-connect",
        classified.kind,
        String(classified.code ?? "none"),
      ],
      tags: {
        subsystem: "stream",
        "stream.failure": classified.kind,
        "stream.code": String(classified.code ?? ""),
      },
      contexts: { stream: { operation: "connect" } },
    },
  );
}

/**
 * The fifth retryable failure in a row. Reported as a WARNING with an
 * `expected` tag, not an error: the pattern behind it is the cold-instance
 * stall (#1124), which the app cannot fix and the user recovers from with
 * Retry (#1625). One fingerprint so every stalled load lands in one issue.
 * FAMILIARISE_WEB-4A / FAMILIARISE_WEB-3N
 */
function reportRetryableConnectExhausted(
  error: unknown,
  classified: ConnectFailure,
): void {
  if (process.env.NODE_ENV === "development") return;
  Sentry.captureException(
    error instanceof Error ? error : new Error(classified.detail),
    {
      level: "warning",
      fingerprint: ["stream-connect", "retryable-exhausted"],
      tags: {
        subsystem: "stream",
        expected: "true",
        "stream.failure": "retryable-exhausted",
        "stream.code": String(classified.code ?? ""),
        platform: "cold-instance",
      },
      contexts: {
        stream: { operation: "connect", attempts: MAX_CONNECT_ATTEMPTS },
      },
    },
  );
}

/**
 * The connector takes no `children`. It renders nothing and publishes the
 * connection to the store instead — see lib/stream/connection-store.ts for why
 * (SSR of the dashboard subtree, and the remount storm).
 */
export interface StreamConnectorProps {
  userId: string;
  enableChat?: boolean;
  enableVideo?: boolean;
}
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

/**
 * Undo the "sync kicked" marks so a later render can retry.
 *
 * Safe to clear the in-memory marker here despite it meaning "kicked, possibly
 * in flight" — this runs only once the promise has settled, so there is nothing
 * left in flight to double up on.
 */
function markSyncIncomplete(userId: string, syncKey: string) {
  clientSyncCompletedUsers.delete(userId);
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(syncKey);
  }
}

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

/**
 * The two clients as ONE value, deliberately. Held separately they were set by
 * two async connects that race, so the element in the wrapper slot below
 * changed TYPE between renders — `children`, then `<StreamVideo>`, then
 * `<Chat>`, in whichever order the sockets happened to settle. React cannot
 * reconcile a type change in place: it unmounts and remounts the entire
 * subtree, which here is the whole dashboard. That is the remount storm behind
 * "I pressed Join ten times" — an in-flight join was torn down under the user.
 *
 * `null` means "not settled yet", which is distinct from a settled result whose
 * `chat` or `video` is null because that connect failed.
 */
interface SettledStreamClients {
  chat: StreamChat | null;
  video: StreamVideoClient | null;
}

const StreamProviderImpl = ({
  userId,
  enableChat = true,
  enableVideo = true,
}: StreamConnectorProps) => {
  const [clients, setClients] = useState<SettledStreamClients | null>(null);
  const [chatConnected, setChatConnected] = useState(false);
  const [videoConnected, setVideoConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  // We need BOTH a ref and state for retry count: the ref (connectionAttemptsRef)
  // is used inside setTimeout/async closures where state would be stale, while
  // this state variable drives re-renders so the UI shows the correct attempt count.
  const [, setRetryCount] = useState(0);

  // Use ref for connection attempts to avoid stale closures in retry logic
  const connectionAttemptsRef = useRef(0);
  // Guard against concurrent connectUser calls (race: connectVideo resolves first,
  // triggers re-render + effect re-run before connectChat has set globalChatClient)
  const isChatConnectingRef = useRef(false);
  // Track retry timeout so we can cancel on unmount
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const { userDetails, isLoading } = useUserData(userId);

  // The tokens the page arrived with (see components/stream/StreamInitialTokens).
  // Seeded into the cache ONCE per userId, below, so the first connect makes no
  // network hop for its token (FAMILIARISE_WEB-4A / #1124).
  const initialTokens = useStreamInitialTokens();
  const seededForRef = useRef<string | null>(null);

  // The token action refuses to mint without a session, and a tab whose cookie
  // expired while it sat open kept calling it anyway — 8 unauthorized throws on
  // the error feed with nobody to show them to (FAMILIARISE_WEB-10). The
  // client's own copy of the session is the cheap gate.
  //
  // `isPending` counts as ALLOWED on purpose: blocking the first mint on the
  // session round trip would put a serial wait back on the join path, which is
  // exactly what the prefetch effect below exists to remove (#248).
  const { data: clientSession, isPending: isSessionPending } = useSession();
  const signedOut = !isSessionPending && !clientSession?.user?.id;
  const signedOutRef = useRef(false);
  signedOutRef.current = signedOut;

  // Token caching with expiry tracking — use ref to avoid triggering re-renders
  // (useState here caused getCachedToken → connectChat → connectServices to
  //  be recreated on every token fetch, making the connectUser useEffect fire
  //  repeatedly and producing "Consecutive calls to connectUser" warnings)
  // Each token type has its own expiry to avoid one overwriting the other's validity window.
  const tokenCacheRef = useRef<{
    userId?: string;
    chatToken?: string;
    chatExpiresAt?: number;
    videoToken?: string;
    videoExpiresAt?: number;
  }>({});

  const isTokenValid = useCallback(
    (type: "chat" | "video", forUserId: string) => {
      const cache = tokenCacheRef.current;
      // Identity-scoped: a token minted for a prior user must never satisfy
      // this one, even while still unexpired.
      if (cache.userId !== forUserId) return false;
      const token = type === "chat" ? cache.chatToken : cache.videoToken;
      const expiresAt =
        type === "chat" ? cache.chatExpiresAt : cache.videoExpiresAt;
      if (!token || !expiresAt) return false;
      // Check if token expires within next 5 minutes
      return Date.now() < expiresAt - 5 * 60 * 1000;
    },
    [],
  );

  // In-flight token requests, shared so concurrent callers (the prefetch
  // effect below + the connect effects) get ONE server-action round trip
  // instead of racing duplicates. Keyed by userId: a request minted for a
  // prior identity must never resolve for the current one.
  const tokenPromiseRef = useRef<{
    userId?: string;
    chat?: Promise<string>;
    video?: Promise<string>;
  }>({});
  // The SDKs may wrap what a token provider throws; the ref is the reliable
  // handle on the refusal by the time connectServices classifies the failure.
  const tokenRefusalRef = useRef<Refusal | null>(null);

  // Runs synchronously in render, before any effect can call getCachedToken.
  // A ref, not an effect: the prefetch effect below would otherwise fire a
  // fetch for a token the page already carried. Re-seeding is bounded by the
  // guard, and a user switch below wipes the cache and lets the guard reset.
  if (seededForRef.current !== userId) {
    const seeded = seedFromInitialTokens(initialTokens, userId, Date.now());
    if (seeded) {
      tokenCacheRef.current = { userId, ...seeded };
      // getCachedToken wipes both refs when EITHER names another user, so the
      // promise ref must already name this one or the seed is lost at once.
      if (tokenPromiseRef.current.userId !== userId) {
        tokenPromiseRef.current = { userId };
      }
    }
    seededForRef.current = userId;
  }

  const getCachedToken = useCallback(
    async (type: "chat" | "video"): Promise<string> => {
      // A user switch invalidates both caches wholesale before any read.
      if (
        tokenCacheRef.current.userId !== userId ||
        tokenPromiseRef.current.userId !== userId
      ) {
        tokenCacheRef.current = { userId };
        tokenPromiseRef.current = { userId };
      }

      if (isTokenValid(type, userId)) {
        const cache = tokenCacheRef.current;
        return type === "chat" ? cache.chatToken! : cache.videoToken!;
      }

      const existing =
        type === "chat"
          ? tokenPromiseRef.current.chat
          : tokenPromiseRef.current.video;
      if (existing) return existing;

      if (signedOutRef.current) {
        throw new Error("Stream token skipped: no signed-in session");
      }

      // Generate new token. The action RETURNS a refusal (an expired cookie)
      // rather than throwing it, so nothing here reaches Sentry
      // (FAMILIARISE_WEB-13); rethrown locally so the connect path stops.
      const request = (
        type === "chat" ? chatTokenProvider(userId) : tokenProvider(userId)
      ).then((result) => {
        if (!result.ok) {
          const refusal = refusalFromShape(result.refusal, 401);
          tokenRefusalRef.current = refusal;
          throw refusal;
        }
        tokenRefusalRef.current = null;
        return result.data;
      });
      if (type === "chat") tokenPromiseRef.current.chat = request;
      else tokenPromiseRef.current.video = request;

      void request.then(
        (newToken) => {
          // Cache for STREAM_TOKEN_CACHE_MS, ten minutes inside the token TTL.
          const expiresAt = Date.now() + STREAM_TOKEN_CACHE_MS;
          if (type === "chat") {
            tokenCacheRef.current.chatToken = newToken;
            tokenCacheRef.current.chatExpiresAt = expiresAt;
          } else {
            tokenCacheRef.current.videoToken = newToken;
            tokenCacheRef.current.videoExpiresAt = expiresAt;
          }
        },
        () => {},
      );
      // `.finally` returns a DERIVED promise that re-rejects when the request
      // fails; left unattached that is an unhandled rejection on every failed
      // mint. The catch swallows exactly that derived rejection — the original
      // still propagates to `return request` callers.
      void request
        .finally(() => {
          if (tokenPromiseRef.current.userId !== userId) return;
          if (type === "chat" && tokenPromiseRef.current.chat === request) {
            delete tokenPromiseRef.current.chat;
          }
          if (type === "video" && tokenPromiseRef.current.video === request) {
            delete tokenPromiseRef.current.video;
          }
        })
        .catch(() => {});

      return request;
    },
    [userId, isTokenValid],
  );

  // Prefetch both tokens at mount — BEFORE userDetails resolve. Token minting
  // needs only `userId`, but connectUser used to wait for useUserData first and
  // only THEN paid a server-action round trip for the token: two serial waits
  // on the critical path of every dashboard/meetings load. Starting the fetch
  // immediately lets it complete during the user-data query, so connectUser
  // starts the WebSocket the moment its other inputs are ready. Fire-and-forget:
  // failures are handled by the normal connect paths, which re-request via
  // getCachedToken (cleared promise ref → fresh attempt).
  useEffect(() => {
    if (!apiKey || !userId || isSessionPending || signedOut) return;
    if (enableChat && !isTokenValid("chat", userId)) {
      void getCachedToken("chat").catch(() => {});
    }
    if (enableVideo && !isTokenValid("video", userId)) {
      void getCachedToken("video").catch(() => {});
    }
  }, [
    userId,
    enableChat,
    enableVideo,
    getCachedToken,
    isTokenValid,
    isSessionPending,
    signedOut,
  ]);

  // Exponential backoff retry logic
  const getRetryDelay = useCallback((attempt: number) => {
    return Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
  }, []);

  const kickChannelSync = useCallback((targetUserId: string): void => {
    const syncKey = `stream_sync_${targetUserId}`;
    const alreadySynced =
      clientSyncCompletedUsers.has(targetUserId) ||
      (typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem(syncKey) === "1");

    if (alreadySynced) {
      streamLogger.debug("Skipping channel sync (already completed)", {
        userId: targetUserId,
      });
      return;
    }

    streamLogger.info("Starting initial channel sync (background)", {
      userId: targetUserId,
    });
    clientSyncCompletedUsers.add(targetUserId);
    void syncUserEventChannels(targetUserId)
      .then((result) => {
        if (!result?.success) {
          markSyncIncomplete(targetUserId, syncKey);
          streamLogger.warn("Channel sync reported failure", {
            userId: targetUserId,
            error: result?.error,
          });
          return;
        }
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(syncKey, "1");
        }
        streamLogger.info("Initial channel sync completed", {
          userId: targetUserId,
        });
      })
      .catch((syncError) => {
        markSyncIncomplete(targetUserId, syncKey);
        streamLogger.warn("Channel sync failed", {
          userId: targetUserId,
          error: syncError,
        });
      });
  }, []);

  // connectChat/connectVideo RESOLVE to their client (or null) instead of each
  // setting its own state, so the caller can commit both at once and the tree
  // changes shape a single time. See SettledStreamClients.
  const connectChat = useCallback(async () => {
    if (!enableChat || !userDetails || !apiKey) return null;

    // Check if we already have a live global client for this user - adopt it
    const adoptable = getGlobalChatClient();
    if (
      getCurrentStreamUserId() === userDetails.id &&
      adoptable &&
      isChatClientLive(adoptable)
    ) {
      streamLogger.debug("Adopting existing chat client", {
        userId: userDetails.id,
      });
      setChatConnected(true);
      return adoptable;
    }

    // Prevent concurrent connectUser calls (e.g. connectVideo re-render race)
    if (isChatConnectingRef.current) {
      streamLogger.debug("Chat connection already in progress, skipping", {
        userId: userDetails.id,
      });
      return getGlobalChatClient();
    }

    isChatConnectingRef.current = true;

    try {
      streamLogger.debug("Connecting to Stream Chat", {
        userId: userDetails.id,
      });

      const client = StreamChat.getInstance(apiKey);

      // If the singleton is already connected and live for this user, adopt it directly.
      if (
        client.userID &&
        client.userID === userDetails.id &&
        isChatClientLive(client)
      ) {
        streamLogger.debug("Adopting already-connected Stream Chat singleton", {
          userId: userDetails.id,
        });
        setGlobalChatClient(client);
        setCurrentStreamUserId(userDetails.id);
        setChatConnected(true);
        kickChannelSync(userDetails.id);
        return client;
      }

      // If the singleton already holds this user but its socket is down, reopen the connection.
      if (client.userID && client.userID === userDetails.id) {
        setGlobalChatClient(client);
        setCurrentStreamUserId(userDetails.id);

        if (client.wsConnection?.isConnecting) {
          streamLogger.debug(
            "Chat socket already reconnecting; awaiting the event",
            {
              userId: userDetails.id,
            },
          );
          kickChannelSync(userDetails.id);
          return client;
        }

        streamLogger.info("Reopening chat socket for an existing user", {
          userId: userDetails.id,
        });
        await client.openConnection();
        setChatConnected(true);
        kickChannelSync(userDetails.id);
        return client;
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

      setChatConnected(true);

      kickChannelSync(userDetails.id);

      streamLogger.info("Chat connection established", {
        userId: userDetails.id,
      });
      return client;
    } catch (error) {
      streamLogger.warn("Chat connection failed (will retry)", {
        userId: userDetails.id,
      });
      setChatConnected(false);
      throw error;
    } finally {
      isChatConnectingRef.current = false;
    }
  }, [enableChat, userDetails, getCachedToken, kickChannelSync]);

  const connectVideo = useCallback(async () => {
    if (!enableVideo || !userDetails || !apiKey) return null;

    // Check if we already have a live global client for this user - adopt it
    const adoptable = getGlobalVideoClient();
    const sameUser = getCurrentStreamUserId() === userDetails.id;
    if (sameUser && adoptable && isVideoClientLive(adoptable)) {
      streamLogger.debug("Adopting existing video client", {
        userId: userDetails.id,
      });
      setVideoConnected(true);
      return adoptable;
    }

    try {
      if (sameUser && adoptable) {
        const coordinator = adoptable.streamClient;

        if (coordinator.wsConnection?.isConnecting) {
          streamLogger.debug(
            "Video coordinator already reconnecting; awaiting the event",
            { userId: userDetails.id },
          );
          return adoptable;
        }

        streamLogger.info("Reopening video coordinator for an existing user", {
          userId: userDetails.id,
        });
        await coordinator.openConnection();
        setVideoConnected(true);
        return adoptable;
      }

      if (adoptable) {
        await adoptable.disconnectUser().catch(() => undefined);
      }

      streamLogger.debug("Connecting to Stream Video", {
        userId: userDetails.id,
      });

      const client = new StreamVideoClient({
        apiKey: apiKey,
        options: { maxConnectUserRetries: 1 },
      });
      try {
        await client.connectUser(
          {
            id: userDetails.id,
            name: userDetails.name ?? userDetails.id,
            image: userDetails.image ?? undefined,
          },
          () => getCachedToken("video"),
        );
      } catch (error) {
        // Release the coordinator so nothing keeps the failed client alive;
        // the global ref is only ever set for a client that connected.
        await client.disconnectUser().catch(() => undefined);
        throw error;
      }

      // Store in global reference
      setGlobalVideoClient(client);
      setCurrentStreamUserId(userDetails.id);

      setVideoConnected(true);
      streamLogger.info("Video connection established", {
        userId: userDetails.id,
      });
      return client;
    } catch (error) {
      streamLogger.warn("Video connection failed", {
        userId: userDetails.id,
      });
      setVideoConnected(false);
      throw error;
    }
  }, [enableVideo, userDetails, getCachedToken]);

  // Stable connectServices function using ref pattern for retry logic
  const connectServices = useCallback(async () => {
    if (isLoading || !userDetails) return;
    // A scheduled idle-callback or retry timeout can still fire after
    // sign-out; getCachedToken then rejects and the catch below would queue
    // up to 5 more retries for a session that is never coming back.
    if (signedOutRef.current) return;

    setIsConnecting(true);
    setError(null);

    try {
      // allSettled, not all: `all` rejects on the first failure and abandons the
      // other client's result, so a chat failure discarded a perfectly good
      // video client. Both outcomes are now committed together, which is also
      // what keeps the tree from changing shape twice.
      const [chatResult, videoResult] = await Promise.allSettled([
        connectChat(),
        connectVideo(),
      ]);

      setClients({ chat: settled(chatResult), video: settled(videoResult) });

      const failure = [chatResult, videoResult].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") throw failure.reason;

      connectionAttemptsRef.current = 0; // Reset on success
      setRetryCount(0);
    } catch (error) {
      const refusal = isRefusal(error) ? error : tokenRefusalRef.current;
      if (refusal) {
        // Not retried and not reported: the server answered, and the answer
        // is "sign in again".
        setError(refusal.userMessage);
        setFailure(refusedConnectFailure(refusal));
        return;
      }
      const classified = classifyConnectFailure(error);
      setError(classified.detail || "Connection failed");
      setFailure(classified);

      // Implement exponential backoff retry using ref
      connectionAttemptsRef.current += 1;
      setRetryCount(connectionAttemptsRef.current); // Sync state for UI display
      const currentAttempts = connectionAttemptsRef.current;
      const signedOut = signedOutRef.current;

      if (classified.kind !== "retryable") {
        // Stream said this cannot succeed as-is (deactivated user, bad token,
        // suspended app). Report once and stop: the five backoff retries per
        // client per page were the Sentry noise.
        if (!signedOut) reportNonRetryableConnectFailure(error, classified);
        return;
      }
      if (signedOut) {
        streamLogger.debug("Skipping retry — signed out", {
          attempt: currentAttempts,
        });
        return;
      }
      if (currentAttempts >= MAX_CONNECT_ATTEMPTS) {
        streamLogger.warn("Max connection attempts reached", {
          attempts: currentAttempts,
          detail: classified.detail,
        });
        reportRetryableConnectExhausted(error, classified);
        return;
      }

      const delay = getRetryDelay(currentAttempts);
      streamLogger.debug(`Retrying connection in ${delay}ms`, {
        attempt: currentAttempts,
      });
      setIsConnecting(false);
      retryTimeoutRef.current = setTimeout(() => {
        // Re-run connection (the ref ensures we get current attempt count)
        connectServices();
      }, delay);
    } finally {
      setIsConnecting(false);
    }
  }, [isLoading, userDetails, connectChat, connectVideo, getRetryDelay]);

  const retryConnection = useCallback(() => {
    connectionAttemptsRef.current = 0;
    setError(null);
    setFailure(null);
    connectServices();
  }, [connectServices]);

  useEffect(() => {
    if (!(!isLoading && userDetails && apiKey) || signedOut) {
      return;
    }
    const hasSeededTokens =
      (!enableChat || isTokenValid("chat", userDetails.id)) &&
      (!enableVideo || isTokenValid("video", userDetails.id));
    if (isSessionPending && !hasSeededTokens) {
      return;
    }

    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      if (
        getCurrentStreamUserId() &&
        getCurrentStreamUserId() !== userDetails.id
      ) {
        streamLogger.info("User changed, reconnecting", {
          from: getCurrentStreamUserId(),
          to: userDetails.id,
        });
        tokenCacheRef.current = {};
        connectionAttemptsRef.current = 0;
        disconnectStreamClients()
          .catch((err) => {
            streamLogger.warn(
              "Prior-user disconnect failed, connecting anyway",
              {
                error: err,
              },
            );
          })
          .finally(() => {
            connectServices();
          });
      } else {
        connectServices();
      }
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = (
        window as Window & {
          requestIdleCallback: (
            cb: () => void,
            opts?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback(run, { timeout: 300 });
    } else {
      timeoutHandle = setTimeout(run, 0);
    }

    return () => {
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
    };
  }, [
    userDetails,
    isLoading,
    enableChat,
    enableVideo,
    isTokenValid,
    isSessionPending,
    signedOut,
    connectServices,
  ]);

  useEffect(() => {
    setStreamConnection({
      clients,
      chatConnected,
      videoConnected,
      isConnecting,
      error,
      failure,
    });
  }, [clients, chatConnected, videoConnected, isConnecting, error, failure]);

  useEffect(() => {
    const chat = clients?.chat;
    if (!chat) return;

    let graceTimeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const cancelGrace = () => {
      if (graceTimeout !== undefined) {
        clearTimeout(graceTimeout);
        graceTimeout = undefined;
      }
    };

    const handler = chat.on((event) => {
      if (event.type !== "connection.changed") return;

      if (event.online) {
        cancelGrace();
        streamLogger.debug("Chat socket recovered", {
          userId: userDetails?.id,
        });
        setChatConnected(true);
        return;
      }

      streamLogger.warn("Chat socket dropped; waiting to reconnect", {
        userId: userDetails?.id,
      });
      setChatConnected(false);
      cancelGrace();
      graceTimeout = setTimeout(() => {
        if (cancelled || signedOutRef.current) return;
        streamLogger.info(
          "Chat still offline after the grace window; reconnecting",
          {
            userId: userDetails?.id,
          },
        );
        if (userDetails?.id) {
          markSyncIncomplete(userDetails.id, `stream_sync_${userDetails.id}`);
        }
        void connectServices().catch(() => {});
      }, RECONNECT_GRACE_MS);
    });

    return () => {
      cancelled = true;
      cancelGrace();
      handler.unsubscribe();
    };
  }, [clients?.chat, userDetails?.id, connectServices]);

  useEffect(() => {
    const video = clients?.video;
    if (!video) return;

    let graceTimeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const cancelGrace = () => {
      if (graceTimeout !== undefined) {
        clearTimeout(graceTimeout);
        graceTimeout = undefined;
      }
    };

    const unsubscribe = video.on("connection.changed", (event) => {
      if (event.online) {
        cancelGrace();
        streamLogger.debug("Video coordinator recovered", {
          userId: userDetails?.id,
        });
        setVideoConnected(true);
        return;
      }

      streamLogger.warn("Video coordinator dropped; waiting to reconnect", {
        userId: userDetails?.id,
      });
      setVideoConnected(false);
      cancelGrace();
      graceTimeout = setTimeout(() => {
        if (cancelled || signedOutRef.current) return;
        streamLogger.info(
          "Video still offline after the grace window; reconnecting",
          { userId: userDetails?.id },
        );
        void connectServices().catch(() => {});
      }, RECONNECT_GRACE_MS);
    });

    return () => {
      cancelled = true;
      cancelGrace();
      unsubscribe();
    };
  }, [clients?.video, userDetails?.id, connectServices]);

  useEffect(() => {
    const onRetry = () => retryConnection();
    window.addEventListener("stream:retry-connection", onRetry);
    return () => window.removeEventListener("stream:retry-connection", onRetry);
  }, [retryConnection]);

  return null;
};

export default StreamProviderImpl;
