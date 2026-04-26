import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

import {
  getMaintenanceState,
  isMaintenanceExempt,
  validateBypass,
  isWriteBlockedInDegraded,
} from "@/lib/maintenance-edge";
import {
  authLimiter,
  searchLimiter,
  eligibilityLimiter,
  newsletterLimiter,
  availabilityLimiter,
  orgInviteAcceptLimiter,
  ssoDomainCheckLimiter,
  orgWalletTopUpLimiter,
  applyRateLimit,
  getClientIp,
} from "@/lib/rate-limit";

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
  // API routes requiring a session cookie (returns 401 JSON without one)
  AUTHENTICATED_API_PREFIXES: [
    "/api/inngest/",
    "/api/form/onboarding/",
    "/api/verification/",
    "/api/user/",
    "/api/events/",
    "/api/plans/",
    "/api/participants/", // Private: participant management for classes/webinars/etc.
    "/api/dashboard/", // Private: dashboard data routes
    "/api/trials/", // Private: trial session routes (public sub-routes exempted below)
    "/api/slots/", // Private: appointment slot data and mutations
    "/api/admin/", // Private: platform admin operations (handler-level auth still runs)
    "/api/staff/", // Private: platform staff operations (handler-level auth still runs)
    "/api/organizations/", // Private: enterprise org CRUD, members, billing, sso (handler-level requireOrgAccess still runs)
  ],
  // Note: /api/auth/ must remain public for BetterAuth to work
  // /api/user/consultants routes are public for explore page (verification filter enforced in API)
  // /api/user/reviews is public for displaying reviews on consultant profiles
  // /api/plans/classes and /api/plans/webinars are public for browse/detail pages;
  //   their sub-routes (recordings, materials) enforce auth in their own handlers
  PUBLIC_API_PREFIXES: [
    "/api/auth/", // BetterAuth core + SSO endpoints (including /api/auth/sso/domain-check)
    "/api/health/",
    "/api/user/consultants", // Public: explore experts list and individual profiles
    "/api/user/reviews", // Public: consultant reviews
    "/api/plans/classes", // Public: browse and view class plans (sub-routes enforce their own auth)
    "/api/plans/webinars", // Public: browse and view webinar plans (sub-routes enforce their own auth)
    "/api/slots/availability/", // Public: consultant availability for booking page
    "/api/slots/availability-with-allocation/", // Public: consultant availability with allocation info
  ],
};

// Matches paths ending with a file extension (e.g. .js, .css, .png, .woff2)
// More precise than pathname.includes(".") which false-positives on /api/v2.0/foo
const HAS_FILE_EXTENSION = /\.\w{2,10}$/;

/**
 * Fast route matching using string prefix checks instead of glob patterns.
 * Also matches the exact path without trailing slash (e.g. "/settings" matches "/settings/").
 */
const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  for (const prefix of prefixes) {
    if (pathname.startsWith(prefix)) return true;
    // Check exact match without trailing slash: "/settings" matches "/settings/"
    if (prefix.endsWith("/") && pathname === prefix.slice(0, -1)) return true;
  }
  return false;
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
    HAS_FILE_EXTENSION.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Maintenance mode check (fail-open: defaults to OFF if Redis unreachable)
  const maintenanceState = await getMaintenanceState();
  if (maintenanceState.phase !== "OFF" && !isMaintenanceExempt(pathname)) {
    if (!validateBypass(req, maintenanceState.bypassSecret)) {
      if (maintenanceState.phase === "OFFLINE") {
        const offlineHeaders: Record<string, string> = {};
        if (maintenanceState.estimatedEnd) {
          const retryAfterSecs = Math.ceil(
            (new Date(maintenanceState.estimatedEnd).getTime() - Date.now()) /
              1000,
          );
          if (retryAfterSecs > 0) {
            offlineHeaders["Retry-After"] = String(retryAfterSecs);
          }
        }

        // API callers should receive machine-readable 503 JSON, not rewritten HTML.
        if (pathname.startsWith("/api/")) {
          return NextResponse.json(
            {
              error: "Service temporarily unavailable during maintenance",
              phase: "OFFLINE",
              reason: maintenanceState.reason || null,
              estimatedEnd: maintenanceState.estimatedEnd || null,
            },
            { status: 503, headers: offlineHeaders },
          );
        }

        const response = NextResponse.rewrite(new URL("/maintenance", req.url));
        Object.entries(offlineHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
      // DEGRADED: block transactional writes; allow reads with banner headers
      if (isWriteBlockedInDegraded(pathname, req.method)) {
        const degradedHeaders: Record<string, string> = {};
        if (maintenanceState.estimatedEnd) {
          const retryAfterSecs = Math.ceil(
            (new Date(maintenanceState.estimatedEnd).getTime() - Date.now()) /
              1000,
          );
          if (retryAfterSecs > 0)
            degradedHeaders["Retry-After"] = String(retryAfterSecs);
        }
        return NextResponse.json(
          {
            error: "Writes are temporarily unavailable during maintenance",
            phase: "DEGRADED",
            reason: maintenanceState.reason || null,
            estimatedEnd: maintenanceState.estimatedEnd || null,
          },
          { status: 503, headers: degradedHeaders },
        );
      }
      const response = NextResponse.next();
      response.headers.set("x-maintenance-phase", "degraded");
      response.headers.set(
        "x-maintenance-reason",
        encodeURIComponent(maintenanceState.reason || ""),
      );
      response.headers.set(
        "x-maintenance-eta",
        encodeURIComponent(maintenanceState.estimatedEnd || ""),
      );
      return response;
    }
  }

  // Edge rate limiting for high-traffic public endpoints (IP-based).
  // Runs before any serverless function is invoked — prevents cost amplification
  // under DDoS even when every request would otherwise return 429.

  // Auth brute-force protection — POST only; skip for localhost (dev testing)
  const clientIp = getClientIp(req);
  const isLocalhost =
    clientIp === "::1" || clientIp === "127.0.0.1" || clientIp === "unknown_ip";
  if (
    !isLocalhost &&
    req.method === "POST" &&
    (pathname.startsWith("/api/auth/sign-in") ||
      pathname.startsWith("/api/auth/sign-up") ||
      pathname.startsWith("/api/auth/forget-password"))
  ) {
    const rl = await applyRateLimit(authLimiter, clientIp);
    if (rl) return rl;
  }

  if (pathname.startsWith("/api/user/consultants")) {
    const rl = await applyRateLimit(searchLimiter, clientIp);
    if (rl) return rl;
  }
  if (pathname.startsWith("/api/trials/check-eligibility")) {
    const rl = await applyRateLimit(eligibilityLimiter, clientIp);
    if (rl) return rl;
  }
  if (
    pathname.startsWith("/api/newsletter/subscribe") &&
    req.method === "POST"
  ) {
    const rl = await applyRateLimit(newsletterLimiter, clientIp);
    if (rl) return rl;
  }
  if (pathname.startsWith("/api/slots/availability/")) {
    const rl = await applyRateLimit(availabilityLimiter, clientIp);
    if (rl) return rl;
  }

  // Enterprise rate limits — skip for localhost so dev/test flows aren't
  // blocked by the same token the test would try to burn.
  if (!isLocalhost) {
    // Invite-accept floods. The orgId isn't in the URL path (it's
    // inside the invitation token body), so keyed by IP here —
    // org-level observability is handled by the per-accept audit
    // log. Covers credential-stuffing where a script sprays accepts
    // against stolen invite tokens.
    if (
      req.method === "POST" &&
      pathname === "/api/organizations/invitations/accept"
    ) {
      const rl = await applyRateLimit(orgInviteAcceptLimiter, clientIp);
      if (rl) return rl;
    }

    // SSO domain-check enumeration. Pre-login endpoint returns
    // "enforceSSO: true" + org name for any domain the platform
    // recognizes — hit in a loop it leaks the tenant list. IP-keyed
    // 60/hr is wide enough for a legitimate shared-office NAT.
    if (
      req.method === "GET" &&
      pathname.startsWith("/api/auth/sso/domain-check")
    ) {
      const rl = await applyRateLimit(ssoDomainCheckLimiter, clientIp);
      if (rl) return rl;
    }

    // Wallet top-up create — orgId is in the URL path
    // (/api/organizations/<orgId>/billing-account/wallet/top-ups).
    // Extract it and key the bucket per-org so one tenant can't
    // DoS their own top-up endpoint or mint hundreds of Razorpay
    // orders under a single billing account.
    if (
      req.method === "POST" &&
      pathname.endsWith("/billing-account/wallet/top-ups") &&
      pathname.startsWith("/api/organizations/")
    ) {
      const orgId = pathname.split("/")[3];
      if (orgId) {
        const rl = await applyRateLimit(
          orgWalletTopUpLimiter,
          `org:${orgId}`,
        );
        if (rl) return rl;
      }
    }
  }

  // Handle public API routes first (most common, no auth needed)
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_API_PREFIXES)) {
    return NextResponse.next();
  }

  // Check for session cookie (fast, no DB hit)
  const sessionCookie = getSessionCookie(req);
  const isAuthenticated = !!sessionCookie;

  // Handle authenticated API routes (require session cookie)
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.AUTHENTICATED_API_PREFIXES)) {
    return isAuthenticated
      ? NextResponse.next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle public auth routes — always allow through.
  // The signin page validates the session client-side via useSession() and
  // redirects authenticated users itself. Doing it here based on cookie
  // presence causes infinite loops when the cookie is stale (DB session gone).
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PUBLIC_AUTH_PREFIXES)) {
    // Do NOT redirect cookie-present users to /dashboard here.
    // Cookie presence ≠ session validity — stale cookies cause an infinite
    // redirect loop: requireOnboarded() → /auth/signin → /dashboard → /auth/signin.
    // The signin/signup pages already redirect authenticated users via useEffect.
    return NextResponse.next();
  }

  // Handle protected routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_PREFIXES)) {
    if (!isAuthenticated) {
      // Preserve callbackUrl for all protected routes
      const signInUrl = new URL(URLS.SIGNIN, req.url);
      signInUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
      return NextResponse.redirect(signInUrl);
    }
    // SSO enforcement happens in customSession() in lib/auth.ts — it marks
    // ssoEnforcementFailed: true on the session. Page layouts/server components
    // check this flag and redirect. We cannot call auth.api.getSession() here
    // because @better-auth/sso imports node:crypto/node:dns which are not
    // available in the Edge Runtime that middleware compiles to.
    return NextResponse.next();
  }

  // Allow access to all other routes
  return NextResponse.next();
}

// Optimized matcher to reduce middleware execution
export const config = {
  matcher: [
    // Match root and all paths except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)",
    // Include API routes
    "/api/(.*)",
  ],
};
