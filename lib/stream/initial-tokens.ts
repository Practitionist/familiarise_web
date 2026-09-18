import "server-only";

import {
  generateChatToken,
  generateVideoToken,
  isStreamConfigured,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  STREAM_TOKEN_CACHE_MS,
  STREAM_TOKEN_TTL_SECONDS,
} from "@/lib/stream/token-ttl";

/**
 * The first chat/video tokens, minted by the RSC layout that owns the session.
 * `expiresAt` is the cache horizon in server epoch ms, not the token's `exp`.
 * See docs/stream/08-token-management.md, "The first token arrives with the page".
 */
export interface StreamInitialTokens {
  userId: string;
  chatToken?: string;
  videoToken?: string;
  expiresAt: number;
}

/**
 * `null` when Stream is unconfigured or minting fails; never throws, because
 * the client falls back to the token action either way (FAMILIARISE_WEB-4A).
 */
export function mintInitialStreamTokens(
  userId: string,
  opts: { chat: boolean; video: boolean },
): StreamInitialTokens | null {
  if (!isStreamConfigured()) return null;
  try {
    return {
      userId,
      chatToken: opts.chat
        ? generateChatToken(userId, STREAM_TOKEN_TTL_SECONDS)
        : undefined,
      videoToken: opts.video
        ? generateVideoToken(userId, STREAM_TOKEN_TTL_SECONDS)
        : undefined,
      expiresAt: Date.now() + STREAM_TOKEN_CACHE_MS,
    };
  } catch (error) {
    streamLogger.warn("Initial Stream token mint failed; client will fetch", {
      userId,
      error,
    });
    return null;
  }
}
