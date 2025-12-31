import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";

// Constants for common URLs and route patterns
const URLS = {
  SIGNIN: "/auth/signin",
  DASHBOARD: "/dashboard",
  ONBOARDING: "/form/onboarding",
};

// Simplified route patterns for better performance
const ROUTE_PATTERNS = {
  // Use simple string checks instead of micromatch for better performance
  PRIVATE_PREFIXES: [],
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
  PROTECTED_API_PREFIXES: ["/api/form/onboarding/"],
  PUBLIC_API_PREFIXES: ["/api/user/", "/api/auth/"],
};

// Define the structure of the token
interface Token {
  name: string;
  email: string;
  role: "CONSULTANT" | "CONSULTEE" | "STAFF";
  onboardingCompleted: boolean;
  consultantProfileId?: string;
  consulteeProfileId?: string;
  staffProfileId?: string;
  picture: string;
  exp: number;
  iat: number;
  jti: string;
  sub: string;
}

// Cache for token verification to reduce repeated JWT parsing
const tokenCache = new Map<
  string,
  { token: Token | null; timestamp: number }
>();
const CACHE_TTL = 60 * 1000; // 1 minute cache

/**
 * Fast route matching using string prefix checks instead of glob patterns
 */
const matchesAnyPrefix = (pathname: string, prefixes: string[]): boolean => {
  return prefixes.some((prefix) => pathname.startsWith(prefix));
};

/**
 * Get cached token or fetch new one
 */
const getCachedToken = async (req: NextRequest): Promise<Token | null> => {
  const authHeader = req.headers.get("authorization");
  const sessionCookie =
    req.cookies.get("next-auth.session-token")?.value ||
    req.cookies.get("__Secure-next-auth.session-token")?.value;

  const cacheKey = authHeader || sessionCookie || "anonymous";
  const cached = tokenCache.get(cacheKey);

  // Return cached token if still valid
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.token;
  }

  // Fetch new token
  const token = (await getToken({ req })) as Token | null;

  // Cache the result
  tokenCache.set(cacheKey, { token, timestamp: Date.now() });

  // Clean old cache entries periodically
  if (tokenCache.size > 1000) {
    const cutoff = Date.now() - CACHE_TTL;
    tokenCache.forEach((value, key) => {
      if (value.timestamp < cutoff) {
        tokenCache.delete(key);
      }
    });
  }

  return token;
};

/**
 * Get the correct dashboard URL based on user role and profile
 */
const getDashboardUrl = (token: Token): string => {
  const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
    token;

  if (role === "CONSULTANT" && consultantProfileId) {
    return `/dashboard/consultant/${consultantProfileId}/home`;
  }
  if (role === "CONSULTEE" && consulteeProfileId) {
    return `/dashboard/consultee/${consulteeProfileId}/home`;
  }
  if (role === "STAFF" && staffProfileId) {
    return `/dashboard/staff/${staffProfileId}/home`;
  }

  return URLS.DASHBOARD; // Fallback
};

/**
 * Optimized middleware function with early returns and simplified logic
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Skip middleware in development/test for faster development
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

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

  // Get token with caching
  const token = await getCachedToken(req);
  const isAuthenticated = !!token;
  const isOnboarded = token?.onboardingCompleted ?? false;

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
    if (isAuthenticated && token) {
      if (!isOnboarded) {
        return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
      }
      const dashboardUrl = getDashboardUrl(token);
      return NextResponse.redirect(new URL(dashboardUrl, req.url));
    }
    return NextResponse.next();
  }

  // Handle protected routes
  if (matchesAnyPrefix(pathname, ROUTE_PATTERNS.PROTECTED_PREFIXES)) {
    // Require authentication
    if (!isAuthenticated) {
      // For meeting routes, preserve the meeting URL as callbackUrl
      if (pathname.startsWith("/meetings/")) {
        const signInUrl = new URL(URLS.SIGNIN, req.url);
        signInUrl.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(signInUrl);
      }
      return NextResponse.redirect(new URL(URLS.SIGNIN, req.url));
    }

    // Handle onboarding flow
    if (!isOnboarded && pathname !== URLS.ONBOARDING) {
      return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
    }

    // Redirect away from onboarding if already completed
    if (pathname === URLS.ONBOARDING && isOnboarded && token) {
      const dashboardUrl = getDashboardUrl(token);
      return NextResponse.redirect(new URL(dashboardUrl, req.url));
    }

    // Handle dashboard URL validation
    if (pathname.startsWith("/dashboard/") && token) {
      const correctDashboardUrl = getDashboardUrl(token);
      const baseDashboardUrl = correctDashboardUrl.replace("/home", "");

      if (
        !pathname.startsWith(baseDashboardUrl) &&
        pathname !== correctDashboardUrl
      ) {
        return NextResponse.redirect(new URL(correctDashboardUrl, req.url));
      }
    }

    return NextResponse.next();
  }

  // Handle root path for authenticated users
  if (token && pathname === "/") {
    if (!isOnboarded) {
      return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
    }
    const dashboardUrl = getDashboardUrl(token);
    return NextResponse.redirect(new URL(dashboardUrl, req.url));
  }

  // Enforce onboarding for all authenticated users on any route (production only)
  // This ensures new signups via OAuth are redirected to onboarding
  if (isAuthenticated && !isOnboarded && pathname !== URLS.ONBOARDING) {
    return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
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
