import { cache } from "react";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * Request-memoized session read. Nested layouts that call requireOnboarded /
 * requireAuth in the same RSC render share one Better Auth getSession call
 * instead of re-running customSession enrichment for each guard.
 *
 * Keyed by disableCookieCache so a force-fresh read never serves a cached
 * cookie-cache result (and vice versa) within the same request.
 */
const getSessionCached = cache(async (disableCookieCache: boolean) => {
  return auth.api.getSession({
    headers: await headers(),
    ...(disableCookieCache && { query: { disableCookieCache: true } }),
  });
});

export async function getSession(disableCookieCache = false) {
  return getSessionCached(disableCookieCache);
}
