import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { safeSameOriginPath } from "@/lib/safe-callback-url";

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

export async function GET(request: Request) {
  const cookieStore = await cookies();
  for (const name of SESSION_COOKIES) {
    cookieStore.delete(name);
  }

  const url = new URL("/auth/signin", request.url);
  const safe = safeSameOriginPath(
    new URL(request.url).searchParams.get("callbackUrl"),
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
