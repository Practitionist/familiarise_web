import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

// Constants for common URLs and route patterns
const URLS = {
  SIGNIN: "/auth/signin",
  ONBOARDING: "/form/onboarding",
};

// Simplified route patterns for better performance
const ROUTE_PATTERNS = {
  PROTECTED_PREFIXES: [
    "/form/",
    "/dashboard/",
    "/settings/",
    "/profile/",
    "/checkout/",
    "/meetings/",
  ],
  PUBLIC_AUTH_PREFIXES: ["/auth/"],
  PRIVATE_API_PREFIXES: ["/api/inngest/"],
  PROTECTED_API_PREFIXES: ["/api/form/onboarding/", "/api/verification/"],
  PUBLIC_API_PREFIXES: ["/api/user/", "/api/auth/"],
};

/**
 * Fast route matching using string prefix checks instead of glob patterns
 */
const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  return prefixes.some((prefix) => pathname.startsWith(prefix));
};

/**
 * Cookie-based middleware — no DB hit, no JWT parsing.
 * Session cookie presence = "likely authenticated".
 * Actual session validation happens in API routes / server components.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Early return for static assets and Next.js internals
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Handle public API routes first (most common, no auth needed)
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_API_PREFIXES)) {
    return NextResponse.next();
  }

  // Check for session cookie (fast, no DB hit)
  const sessionCookie = getSessionCookie(req);
  const isAuthenticated = !!sessionCookie;

  // Handle private API routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PRIVATE_API_PREFIXES)) {
    return isAuthenticated
      ? NextResponse.next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle protected API routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_API_PREFIXES)) {
    return isAuthenticated
      ? NextResponse.next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle public auth routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_AUTH_PREFIXES)) {
    // Redirect authenticated users away from auth pages
    // Client-side handles dashboard routing based on role
    if (isAuthenticated) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  // Handle protected routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_PREFIXES)) {
    if (!isAuthenticated) {
      // For meeting routes, preserve the meeting URL as callbackUrl
      if (pathname.startsWith("/meetings/")) {
        const signInUrl = new URL(URLS.SIGNIN, req.url);
        signInUrl.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(signInUrl);
      }
      return NextResponse.redirect(new URL(URLS.SIGNIN, req.url));
    }
    return NextResponse.next();
  }

  // Allow access to all other routes
  return NextResponse.next();
}

// Optimized matcher to reduce middleware execution
export const config = {
  matcher: [
    // Skip all static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).+)",
    // Include API routes
    "/api/(.*)",
  ],
};
