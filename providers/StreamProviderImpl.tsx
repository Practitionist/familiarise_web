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
  type MutableRefObject,
} from "react";
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
import { withJitter } from "@/lib/stream/backoff";
import { useStreamInitialTokens } from "@/components/stream/StreamInitialTokens";
import * as Sentry from "@sentry/nextjs";

/** Backoff attempts for a RETRYABLE connect failure; a non-retryable one stops at 1. */
const MAX_CONNECT_ATTEMPTS = 5;

/** Grace period before app-level reconnect kicks in after a continuous offline state. */
const RECONNECT_GRACE_MS = 8_000;

/** How long a dropped chat socket keeps the chat surface mounted before it counts as disconnected. */
const DISCONNECT_GRACE_MS = 15_000;

const settled = <T,>(result: PromiseSettledResult<T>): T | null =>
  result.status === "fulfilled" ? result.value : null;

type InFlight<T> = { userId: string; promise: Promise<T> } | null;

/** Overlapping connects for one user share a single attempt and its client. */
function joinInFlight<T>(
  slot: MutableRefObject<InFlight<T>>,
  userId: string,
  start: () => Promise<T>,
): Promise<T> {
  if (slot.current?.userId === userId) return slot.current.promise;
  const promise = start().finally(() => {
    if (slot.current?.promise === promise) slot.current = null;
  });
  slot.current = { userId, promise };
  return promise;
}

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
  if (refusal.code === "CONSENT_REQUIRED") {
    return {
      kind: "consent",
      code: null,
      detail: refusal.devMessage,
      title: "Enable live chat & video",
      description: refusal.userMessage,
      message: refusal.userMessage,
      action: "grant_consent",
    };
  }
  return {
    kind: "not-retryable",
    code: null,
    detail: refusal.devMessage,
    title: "Please sign in again",
    description: refusal.userMessage,
    message: refusal.userMessage,
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
import "stream-chat-react/dist/css/index.css";
import "@stream-io/video-react-sdk/dist/css/styles.css";

// Users whose channel sync was kicked in this page load. The sync only tidies the
// viewer's own list; revocation is enforced server-side, so nothing here gates it.
const clientSyncCompletedUsers = new Set<string>();

/** Lets a later connect re-run the sync; called once the previous one settled. */
function markSyncIncomplete(userId: string) {
  clientSyncCompletedUsers.delete(userId);
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

/**
 * A settled result never downgrades a live client to null: a connect that lost
 * its chat or video client keeps the registered singleton the previous commit held.
 */
function mergeSettledClients(
  prev: SettledStreamClients | null,
  next: SettledStreamClients,
): SettledStreamClients {
  const chat =
    next.chat ??
    (prev?.chat && prev.chat === getGlobalChatClient() ? prev.chat : null);
  const video =
    next.video ??
    (prev?.video && prev.video === getGlobalVideoClient() ? prev.video : null);
  if (prev && prev.chat === chat && prev.video === video) return prev;
  return { chat, video };
}

function isConsentUpsertError(upsertError: unknown): boolean {
  const errName =
    typeof upsertError === "object" && upsertError !== null
      ? (upsertError as { name?: unknown }).name
      : undefined;
  if (errName === "ConsentRequiredError") return true;
  let errMessage = "";
  if (upsertError instanceof Error) {
    errMessage = upsertError.message;
  } else if (typeof upsertError === "string") {
    errMessage = upsertError;
  }
  return (
    errMessage.includes("STREAM_DATA_PROCESSING") ||
    errMessage.includes("data-processing consent for messaging")
  );
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
  // The chat socket dropped and is still inside DISCONNECT_GRACE_MS: surfaces
  // keep the chat layout mounted and show a banner instead of a skeleton.
  const [chatReconnecting, setChatReconnecting] = useState(false);
  // We need BOTH a ref and state for retry count: the ref (connectionAttemptsRef)
  // is used inside setTimeout/async closures where state would be stale, while
  // this state variable drives re-renders so the UI shows the correct attempt count.
  const [, setRetryCount] = useState(0);

  // Use ref for connection attempts to avoid stale closures in retry logic
  const connectionAttemptsRef = useRef(0);
  // Overlapping connects for one user await the same attempt instead of racing
  // a second connectUser (or returning a null client while the first is mid-flight).
  const chatInFlightRef = useRef<InFlight<StreamChat | null>>(null);
  const videoInFlightRef = useRef<InFlight<StreamVideoClient | null>>(null);
  // Only the newest connectServices run commits; `activeConnectRef` names the
  // run still in flight so a manual retry never starts a second one.
  const connectGenerationRef = useRef(0);
  const activeConnectRef = useRef<number | null>(null);
  // Track retry timeout so we can cancel on unmount
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const {
    userDetails,
    isLoading,
    failure: profileFailure,
    retry: retryProfile,
  } = useUserData(userId);
  const latestUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    latestUserIdRef.current = userDetails?.id ?? null;
  }, [userDetails?.id]);

  // A profile fetch that ran out of retries is the connect's failure too, and
  // it clears itself once a later fetch succeeds.
  useEffect(() => {
    if (!profileFailure) return;
    setFailure(profileFailure);
    return () => setFailure((prev) => (prev === profileFailure ? null : prev));
  }, [profileFailure]);

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
  const signedOutRef = useRef(signedOut);
  useEffect(() => {
    signedOutRef.current = signedOut;
  }, [signedOut]);

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
          // A mint answered after a user switch must not land in the new user's cache.
          if (tokenCacheRef.current.userId !== userId) return;
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

  // An SDK asks its provider again only to replace a token Stream refused (expired
  // or revoked), so every call after the first skips the cache and mints afresh.
  const sdkTokenProvider = useCallback(
    (type: "chat" | "video") => {
      let served = false;
      return () => {
        if (served) {
          const cache = tokenCacheRef.current;
          if (type === "chat") {
            delete cache.chatToken;
            delete cache.chatExpiresAt;
          } else {
            delete cache.videoToken;
            delete cache.videoExpiresAt;
          }
        }
        served = true;
        return getCachedToken(type);
      };
    },
    [getCachedToken],
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

  // Exponential backoff with jitter, capped so the upper bound stays 30 seconds.
  const getRetryDelay = useCallback((attempt: number) => {
    const base = Math.min(1000 * Math.pow(2, attempt), 30000);
    return withJitter(base);
  }, []);

  const kickChannelSync = useCallback((targetUserId: string): void => {
    if (clientSyncCompletedUsers.has(targetUserId)) {
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
          markSyncIncomplete(targetUserId);
          streamLogger.warn("Channel sync reported failure", {
            userId: targetUserId,
            error: result?.error,
          });
          return;
        }
        streamLogger.info("Initial channel sync completed", {
          userId: targetUserId,
        });
      })
      .catch((syncError) => {
        markSyncIncomplete(targetUserId);
        streamLogger.warn("Channel sync failed", {
          userId: targetUserId,
          error: syncError,
        });
      });
  }, []);

  const adoptOrReopenChatSingleton = useCallback(
    async (client: StreamChat, targetUserId: string) => {
      if (!client.userID || client.userID !== targetUserId) return null;

      setGlobalChatClient(client);
      setCurrentStreamUserId(targetUserId);

      if (isChatClientLive(client)) {
        streamLogger.debug("Adopting already-connected Stream Chat singleton", {
          userId: targetUserId,
        });
        setChatConnected(true);
        kickChannelSync(targetUserId);
        return client;
      }

      if (client.wsConnection?.isConnecting) {
        streamLogger.debug(
          "Chat socket already reconnecting; awaiting the event",
          {
            userId: targetUserId,
          },
        );
        kickChannelSync(targetUserId);
        return client;
      }

      streamLogger.info("Reopening chat socket for an existing user", {
        userId: targetUserId,
      });
      await client.openConnection();
      setChatConnected(true);
      kickChannelSync(targetUserId);
      return client;
    },
    [kickChannelSync],
  );

  // connectChat/connectVideo RESOLVE to their client (or null) instead of each
  // setting its own state, so the caller can commit both at once and the tree
  // changes shape a single time. See SettledStreamClients.
  const connectChat = useCallback(async (): Promise<StreamChat | null> => {
    if (!enableChat || !userDetails || !apiKey) return null;
    const user = userDetails;
    const key = apiKey;

    const adoptable = getGlobalChatClient();
    if (
      getCurrentStreamUserId() === user.id &&
      adoptable &&
      isChatClientLive(adoptable)
    ) {
      streamLogger.debug("Adopting existing chat client", { userId: user.id });
      setChatConnected(true);
      return adoptable;
    }

    return joinInFlight(chatInFlightRef, user.id, async () => {
      try {
        streamLogger.debug("Connecting to Stream Chat", { userId: user.id });

        const client = StreamChat.getInstance(key);
        const adoptedSingleton = await adoptOrReopenChatSingleton(
          client,
          user.id,
        );
        if (adoptedSingleton) {
          return adoptedSingleton;
        }

        if (!clientSyncCompletedUsers.has(user.id)) {
          try {
            await upsertUserToStream(user.id);
            streamLogger.debug("User upserted to Stream", { userId: user.id });
          } catch (upsertError) {
            // Rejects so connectServices records the consent failure instead of clearing it.
            if (isConsentUpsertError(upsertError)) throw upsertError;
            streamLogger.warn("User upsert failed, continuing", {
              userId: user.id,
              error: upsertError,
            });
          }
        }

        await client.connectUser(
          {
            id: user.id,
            name: user.name ?? user.id,
            image: user.image ?? undefined,
            role: mapRoleToStream(user.role),
          },
          sdkTokenProvider("chat"),
        );

        setGlobalChatClient(client);
        setCurrentStreamUserId(user.id);
        setChatConnected(true);
        kickChannelSync(user.id);

        streamLogger.info("Chat connection established", { userId: user.id });
        return client;
      } catch (error) {
        streamLogger.warn("Chat connection failed (will retry)", {
          userId: user.id,
        });
        setChatConnected(false);
        throw error;
      }
    });
  }, [
    enableChat,
    userDetails,
    sdkTokenProvider,
    kickChannelSync,
    adoptOrReopenChatSingleton,
  ]);

  const connectVideo =
    useCallback(async (): Promise<StreamVideoClient | null> => {
      if (!enableVideo || !userDetails || !apiKey) return null;
      const user = userDetails;
      const key = apiKey;

      // Check if we already have a live global client for this user - adopt it
      const adoptable = getGlobalVideoClient();
      const adoptableUserId =
        getCurrentStreamUserId() ??
        (adoptable?.streamClient as { userID?: string } | undefined)?.userID;
      const sameUser = adoptableUserId === user.id;
      if (sameUser && adoptable && isVideoClientLive(adoptable)) {
        streamLogger.debug("Adopting existing video client", {
          userId: user.id,
        });
        setCurrentStreamUserId(user.id);
        setVideoConnected(true);
        return adoptable;
      }

      return joinInFlight(videoInFlightRef, user.id, async () => {
        try {
          if (sameUser && adoptable) {
            const coordinator = adoptable.streamClient;
            setCurrentStreamUserId(user.id);

            if (coordinator.wsConnection?.isConnecting) {
              streamLogger.debug(
                "Video coordinator already reconnecting; awaiting the event",
                { userId: user.id },
              );
              return adoptable;
            }

            streamLogger.info(
              "Reopening video coordinator for an existing user",
              { userId: user.id },
            );
            await coordinator.openConnection();
            setVideoConnected(true);
            return adoptable;
          }

          if (adoptable) {
            await adoptable.disconnectUser().catch(() => undefined);
          }

          streamLogger.debug("Connecting to Stream Video", { userId: user.id });

          const client = new StreamVideoClient({
            apiKey: key,
            options: { maxConnectUserRetries: 1 },
          });
          try {
            await client.connectUser(
              {
                id: user.id,
                name: user.name ?? user.id,
                image: user.image ?? undefined,
              },
              sdkTokenProvider("video"),
            );
          } catch (error) {
            // Release the coordinator so nothing keeps the failed client alive;
            // the global ref is only ever set for a client that connected.
            await client.disconnectUser().catch(() => undefined);
            throw error;
          }

          // The user changed while this client was connecting: release it
          // rather than registering a client for the wrong identity.
          if (latestUserIdRef.current !== user.id) {
            await client.disconnectUser().catch(() => undefined);
            return null;
          }

          setGlobalVideoClient(client);
          setCurrentStreamUserId(user.id);

          setVideoConnected(true);
          streamLogger.info("Video connection established", {
            userId: user.id,
          });
          return client;
        } catch (error) {
          streamLogger.warn("Video connection failed", { userId: user.id });
          setVideoConnected(false);
          throw error;
        }
      });
    }, [enableVideo, userDetails, sdkTokenProvider]);

  // Stable connectServices function using ref pattern for retry logic
  const connectServices = useCallback(async () => {
    if (isLoading || !userDetails) return;
    // A scheduled idle-callback or retry timeout can still fire after
    // sign-out; getCachedToken then rejects and the catch below would queue
    // up to 5 more retries for a session that is never coming back.
    if (signedOutRef.current) return;

    const generation = ++connectGenerationRef.current;
    const isLatest = () => generation === connectGenerationRef.current;
    activeConnectRef.current = generation;
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

      // A newer run owns the commit; it joined the same in-flight connects.
      if (!isLatest()) return;

      const next = { chat: settled(chatResult), video: settled(videoResult) };
      setClients((prev) => mergeSettledClients(prev, next));

      const failure = [chatResult, videoResult].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") throw failure.reason;

      connectionAttemptsRef.current = 0; // Reset on success
      setRetryCount(0);
      setFailure(null);
      setError(null);
    } catch (error) {
      if (!isLatest()) return;
      const refusal = isRefusal(error) ? error : tokenRefusalRef.current;
      if (refusal) {
        // Not retried and not reported: the server answered, and the answer
        // is "sign in again".
        setError(refusal.userMessage);
        setFailure(refusedConnectFailure(refusal));
        return;
      }
      const classified = classifyConnectFailure(error);
      // A retryable failure on a chat socket that already connected is a
      // reconnect: the surface keeps its layout until the budget runs out.
      const deferFailure =
        classified.kind === "retryable" &&
        getGlobalChatClient() !== null &&
        getCurrentStreamUserId() === userDetails.id;
      const showFailure = () => {
        setError(classified.detail || "Connection failed");
        setFailure(classified);
      };
      if (!deferFailure) showFailure();

      // Implement exponential backoff retry using ref
      connectionAttemptsRef.current += 1;
      setRetryCount(connectionAttemptsRef.current); // Sync state for UI display
      const currentAttempts = connectionAttemptsRef.current;
      const signedOut = signedOutRef.current;

      if (classified.kind !== "retryable") {
        // Stream said this cannot succeed as-is (deactivated user, bad token,
        // suspended app). Report once and stop: the five backoff retries per
        // client per page were the Sentry noise.
        if (!signedOut && classified.kind !== "consent") {
          reportNonRetryableConnectFailure(error, classified);
        }
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
        if (deferFailure) showFailure();
        reportRetryableConnectExhausted(error, classified);
        return;
      }

      const delay = getRetryDelay(currentAttempts);
      streamLogger.debug(`Retrying connection in ${delay}ms`, {
        attempt: currentAttempts,
      });
      setIsConnecting(false);
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = setTimeout(() => {
        // Re-run connection (the ref ensures we get current attempt count)
        connectServices();
      }, delay);
    } finally {
      if (activeConnectRef.current === generation) {
        activeConnectRef.current = null;
        setIsConnecting(false);
      }
    }
  }, [isLoading, userDetails, connectChat, connectVideo, getRetryDelay]);

  const retryConnection = useCallback(() => {
    clearTimeout(retryTimeoutRef.current);
    if (!userDetails) {
      retryProfile();
      return;
    }
    if (activeConnectRef.current !== null) return;
    connectionAttemptsRef.current = 0;
    setError(null);
    setFailure(null);
    connectServices();
  }, [connectServices, userDetails, retryProfile]);

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
      chatReconnecting,
      isConnecting,
      error,
      failure,
    });
  }, [
    clients,
    chatConnected,
    videoConnected,
    chatReconnecting,
    isConnecting,
    error,
    failure,
  ]);

  const createConnectionChangeObserver = useCallback(
    (opts: {
      label: "Chat socket" | "Video coordinator";
      setConnected: (connected: boolean) => void;
      setReconnecting?: (reconnecting: boolean) => void;
      onBeforeReconnect?: () => void;
    }) => {
      let graceTimeout: ReturnType<typeof setTimeout> | undefined;
      let disconnectTimeout: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;

      const cancelGrace = () => {
        if (graceTimeout !== undefined) {
          clearTimeout(graceTimeout);
          graceTimeout = undefined;
        }
        if (disconnectTimeout !== undefined) {
          clearTimeout(disconnectTimeout);
          disconnectTimeout = undefined;
        }
      };

      const onConnectionChanged = (online: boolean | undefined) => {
        if (online) {
          cancelGrace();
          streamLogger.debug(`${opts.label} recovered`, {
            userId: userDetails?.id,
          });
          opts.setReconnecting?.(false);
          opts.setConnected(true);
          // The SDK recovered on its own: a transient failure from the drop is stale.
          setFailure((prev) => (prev?.kind === "retryable" ? null : prev));
          return;
        }

        streamLogger.warn(`${opts.label} dropped; waiting to reconnect`, {
          userId: userDetails?.id,
        });
        opts.setConnected(false);
        cancelGrace();
        if (opts.setReconnecting) {
          opts.setReconnecting(true);
          disconnectTimeout = setTimeout(
            () => opts.setReconnecting?.(false),
            DISCONNECT_GRACE_MS,
          );
        }
        graceTimeout = setTimeout(() => {
          if (cancelled || signedOutRef.current) return;
          streamLogger.info(
            `${opts.label} still offline after the grace window; reconnecting`,
            { userId: userDetails?.id },
          );
          opts.onBeforeReconnect?.();
          void connectServices().catch(() => {});
        }, RECONNECT_GRACE_MS);
      };

      // The disconnect timer outlives a re-attached observer so the
      // reconnecting flag always settles; it only clears a flag.
      const dispose = () => {
        cancelled = true;
        if (graceTimeout !== undefined) clearTimeout(graceTimeout);
      };

      return { onConnectionChanged, dispose };
    },
    [userDetails?.id, connectServices],
  );

  useEffect(() => {
    const chat = clients?.chat;
    if (!chat) return;

    const observer = createConnectionChangeObserver({
      label: "Chat socket",
      setConnected: setChatConnected,
      setReconnecting: setChatReconnecting,
      onBeforeReconnect: () => {
        if (userDetails?.id) {
          markSyncIncomplete(userDetails.id);
        }
      },
    });

    const handler = chat.on((event) => {
      if (event.type !== "connection.changed") return;
      observer.onConnectionChanged(event.online);
    });

    return () => {
      observer.dispose();
      handler.unsubscribe();
    };
  }, [clients?.chat, userDetails?.id, createConnectionChangeObserver]);

  useEffect(() => {
    const video = clients?.video;
    if (!video) return;

    const observer = createConnectionChangeObserver({
      label: "Video coordinator",
      setConnected: setVideoConnected,
    });

    const unsubscribe = video.on("connection.changed", (event) => {
      observer.onConnectionChanged(event.online);
    });

    return () => {
      observer.dispose();
      unsubscribe();
    };
  }, [clients?.video, createConnectionChangeObserver]);

  useEffect(() => {
    const onRetry = () => retryConnection();
    window.addEventListener("stream:retry-connection", onRetry);
    return () => window.removeEventListener("stream:retry-connection", onRetry);
  }, [retryConnection]);

  return null;
};

export default StreamProviderImpl;
