import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";

/**
 * Clears stale BetterAuth session cookies and redirects to /auth/signin.
 * Used by auth-guard.ts when a session cookie exists but the DB session is
 * invalid — cookies can only be modified in Route Handlers, not Server Components.
 *
 * Forwards a validated `?callbackUrl=` (when the guard preserved the deep
 * link) so re-signin returns there instead of dropping on the dashboard.
 * Auth URLs are never threaded back into themselves.
 */

const SESSION_COOKIES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth.session_data",
  "__Secure-better-auth.session_data",
];

// Query inputs on app/api/** routes are Zod-parsed per repo convention; the
// bound also keeps an unbounded query string out of URL parsing + the
// Location header. Invalid input is treated as absent so cleanup stays
// reachable — it is a recovery endpoint, not a gated one.
const callbackUrlSchema = z.string().max(2048).optional();

export async function GET(request: Request) {
  const cookieStore = await cookies();
  for (const name of SESSION_COOKIES) {
    cookieStore.delete(name);
  }

  const url = new URL("/auth/signin", request.url);
  const rawCallbackUrl =
    new URL(request.url).searchParams.get("callbackUrl") ?? undefined;
  const parsedCallbackUrl = callbackUrlSchema.safeParse(rawCallbackUrl);
  const safe = safeSameOriginPath(
    parsedCallbackUrl.success ? parsedCallbackUrl.data : undefined,
  );
  if (
    safe &&
    !safe.startsWith("/auth/") &&
    !safe.startsWith("/api/auth/clear-stale-session")
  ) {
    url.searchParams.set("callbackUrl", safe);
  }
  return NextResponse.redirect(url);
}
