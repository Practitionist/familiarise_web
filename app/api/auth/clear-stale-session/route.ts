import * as Sentry from "@sentry/nextjs";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Clears stale BetterAuth session cookies and redirects to /auth/signin.
 * Used by auth-guard.ts when a session cookie exists but the DB session is
 * invalid — cookies can only be modified in Route Handlers, not Server Components.
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
  return NextResponse.redirect(url);
}
