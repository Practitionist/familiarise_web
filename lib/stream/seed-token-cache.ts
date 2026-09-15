import type { StreamInitialTokens } from "@/lib/stream/initial-tokens";

/** The slice of the connector's token cache that a server mint can fill. */
export interface SeededTokenCache {
  chatToken?: string;
  chatExpiresAt?: number;
  videoToken?: string;
  videoExpiresAt?: number;
}

/**
 * Turn the tokens the page arrived with into cache entries for `userId`, or
 * `null` when they belong to someone else or the cache window has passed (a
 * tab restored hours later). Only the types that were minted are seeded, so
 * `enableChat`/`enableVideo` keep their meaning. Pure, so it is pinned without
 * React. #1124 / FAMILIARISE_WEB-4A
 */
export function seedFromInitialTokens(
  initial: StreamInitialTokens | null | undefined,
  userId: string,
  now: number,
): SeededTokenCache | null {
  if (!initial || initial.userId !== userId) return null;
  if (now >= initial.expiresAt) return null;
  const seeded: SeededTokenCache = {};
  if (initial.chatToken) {
    seeded.chatToken = initial.chatToken;
    seeded.chatExpiresAt = initial.expiresAt;
  }
  if (initial.videoToken) {
    seeded.videoToken = initial.videoToken;
    seeded.videoExpiresAt = initial.expiresAt;
  }
  return seeded;
}
