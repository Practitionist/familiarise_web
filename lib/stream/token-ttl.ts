/**
 * Shared by the "use server" token action (which cannot export constants) and
 * the client connector; the window sits inside the TTL. See docs/stream/08.
 */

/** How long a minted chat or video token stays valid. */
export const STREAM_TOKEN_TTL_SECONDS = 3600;

/** How long the connector treats a minted token as reusable. */
export const STREAM_TOKEN_CACHE_MS = 50 * 60 * 1000;
