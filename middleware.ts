import micromatch from "micromatch";
import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";

// Constants for common URLs and route patterns
const URLS = {
  SIGNIN: "/auth/signin",
  DASHBOARD: "/dashboard",
  ONBOARDING: "/form/onboarding",
};

const ROUTES = {
  PROTECTED_ROUTES: [
    "/form/**",
    "/dashboard/**",
    "/settings/**",
    "/profile/**",
  ],
  PUBLIC_AUTH_ROUTES: ["/auth/**"],
  PRIVATE_API: ["/api/inngest/**"],
  PROTECTED_API: ["/api/form/onboarding/**"], // Added onboarding API route
  PUBLIC_API: ["/api/user/**", "/api/auth/*"],
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

/**
 * Check if a pathname matches any of the given patterns
 */
const isMatchingRoute = (pathname: string, patterns: string[]): boolean =>
  micromatch.isMatch(pathname, patterns);

/**
 * Get the correct dashboard URL based on user role and profile
 */
const getCorrectDashboardUrl = (token: Token): string | null => {
  const { role, consultantProfileId, consulteeProfileId, staffProfileId } =
    token;

  if (role === "CONSULTANT" && consultantProfileId) {
    return `/dashboard/consultant/${consultantProfileId}`;
  } else if (role === "CONSULTEE" && consulteeProfileId) {
    return `/dashboard/consultee/${consulteeProfileId}`;
  } else if (role === "STAFF" && staffProfileId) {
    return `/dashboard/staff/${staffProfileId}`;
  }

  return null;
};

/**
 * Handle authentication check and redirection
 */
const handleAuthCheck = (
  isAuthenticated: boolean,
  req: NextRequest,
): NextResponse | null => {
  if (!isAuthenticated) {
    return NextResponse.redirect(new URL(URLS.SIGNIN, req.url));
  }
  return null;
};

/**
 * Handle onboarding check and redirection
 */
const handleOnboardingCheck = (
  isOnboarded: boolean,
  pathname: string,
  req: NextRequest,
): NextResponse | null => {
  if (!isOnboarded && pathname !== URLS.ONBOARDING) {
    return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
  }
  return null;
};

/**
 * Handle dashboard redirection
 */
const handleDashboardRedirect = (
  token: Token,
  pathname: string,
  req: NextRequest,
): NextResponse | null => {
  const correctDashboardUrl = getCorrectDashboardUrl(token);
  if (correctDashboardUrl && pathname !== correctDashboardUrl) {
    return NextResponse.redirect(new URL(correctDashboardUrl, req.url));
  }
  return null;
};

/**
 * Middleware function to handle authentication and authorization for routes.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  // Bypass middleware in test mode
  console.log("NODE_ENV", process.env.NODE_ENV);
  console.log("test user id", process.env.NEXT_PUBLIC_TEST_USERID);
  if (process.env.NODE_ENV === "test") {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  const token = (await getToken({ req })) as Token | null;
  const isAuthenticated = !!token;

  const isOnboarded = token?.onboardingCompleted ?? false;

  // Handle private API routes (including Inngest and Auth)
  if (isMatchingRoute(pathname, ROUTES.PRIVATE_API)) {
    return isAuthenticated
      ? NextResponse.next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle protected API routes
  if (isMatchingRoute(pathname, ROUTES.PROTECTED_API)) {
    return isAuthenticated
      ? NextResponse.next()
      : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Handle public API routes
  if (isMatchingRoute(pathname, ROUTES.PUBLIC_API)) {
    return NextResponse.next();
  }

  // Handle public auth routes
  if (isMatchingRoute(pathname, ROUTES.PUBLIC_AUTH_ROUTES)) {
    if (isAuthenticated) {
      const onboardingCheck = handleOnboardingCheck(isOnboarded, pathname, req);
      if (onboardingCheck) return onboardingCheck;

      if (token) {
        const correctDashboardUrl = getCorrectDashboardUrl(token);
        return NextResponse.redirect(
          new URL(correctDashboardUrl || URLS.DASHBOARD, req.url),
        );
      }
    }
    return NextResponse.next();
  }

  // Handle protected routes
  if (isMatchingRoute(pathname, ROUTES.PROTECTED_ROUTES)) {
    const authCheck = handleAuthCheck(isAuthenticated, req);
    if (authCheck) return authCheck;

    const onboardingCheck = handleOnboardingCheck(isOnboarded, pathname, req);
    if (onboardingCheck) return onboardingCheck;

    if (pathname === URLS.ONBOARDING && isOnboarded && token) {
      const dashboardRedirect = handleDashboardRedirect(token, pathname, req);
      if (dashboardRedirect) return dashboardRedirect;
    }

    if (pathname.startsWith("/dashboard/") && token) {
      const dashboardRedirect = handleDashboardRedirect(token, pathname, req);
      if (dashboardRedirect) return dashboardRedirect;
    }

    return NextResponse.next();
  }

  // Handle other authenticated routes
  if (isAuthenticated) {
    const onboardingCheck = handleOnboardingCheck(isOnboarded, pathname, req);
    if (onboardingCheck) return onboardingCheck;
  }

  // Allow access to all other routes
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
