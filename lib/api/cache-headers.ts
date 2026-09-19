/**
 * Shared Cache-Control header values for API routes.
 *
 * A single home for the two directives this codebase uses so that adding the
 * same header to hundreds of routes does not mint hundreds of duplicated
 * literals (which trips the new-code duplication gate). Import only what a
 * file uses:
 *
 * - `NO_STORE_HEADERS` — private, session/token/cron/machine answers that
 *   must never sit in the shared cache.
 * - `PUBLIC_LIST_HEADERS` — anonymous, user-agnostic listings: CDN-cached
 *   60s with background revalidation. Pair with a write-site purge
 *   (`revalidateTag`/`revalidatePath`); the TTL is only the safety net.
 */
export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
};

export const PUBLIC_LIST_HEADERS: Record<string, string> = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};
