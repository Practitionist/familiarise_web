import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

import {
  getMaintenanceState,
  isMaintenanceExempt,
  validateBypass,
} from "@/lib/maintenance";

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
  PROTECTED_API_PREFIXES: [
    "/api/form/onboarding/",
    "/api/verification/",
    "/api/user/",
    "/api/events/",
    "/api/plans/",
  ],
  // Note: /api/auth/ must remain public for BetterAuth to work
  // /api/user/consultants routes are public for explore page (verification filter enforced in API)
  // /api/user/reviews is public for displaying reviews on consultant profiles
  PUBLIC_API_PREFIXES: [
    "/api/auth/",
    "/api/health/",
    "/api/user/consultants", // Public: explore experts list and individual profiles
    "/api/user/reviews", // Public: consultant reviews
  ],
};

/**
 * Fast route matching using string prefix checks instead of glob patterns.
 * Also matches the exact path without trailing slash (e.g. "/settings" matches "/settings/").
 */
const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  return prefixes.some(
    (prefix) =>
      pathname.startsWith(prefix) || pathname === prefix.replace(/\/$/, ""),
  );
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

  // Maintenance mode check (fail-open: defaults to OFF if Redis unreachable)
  const maintenanceState = await getMaintenanceState();
  if (
    maintenanceState.phase !== "OFF" &&
    !isMaintenanceExempt(pathname)
  ) {
    if (!validateBypass(req, maintenanceState.bypassSecret)) {
      if (maintenanceState.phase === "OFFLINE") {
        return NextResponse.rewrite(new URL("/maintenance", req.url));
      }
      // DEGRADED: add headers for client-side banner, continue normally
      const response = NextResponse.next();
      response.headers.set("x-maintenance-phase", "degraded");
      response.headers.set(
        "x-maintenance-reason",
        maintenanceState.reason || "",
      );
      response.headers.set(
        "x-maintenance-eta",
        maintenanceState.estimatedEnd || "",
      );
      return response;
    }
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
    // Redirect authenticated users to dashboard immediately
    // This prevents the flash of auth page before client-side redirect kicks in
    if (isAuthenticated) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  // Handle protected routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_PREFIXES)) {
    if (!isAuthenticated) {
      // Preserve callbackUrl for all protected routes
      const signInUrl = new URL(URLS.SIGNIN, req.url);
      signInUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(signInUrl);
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
