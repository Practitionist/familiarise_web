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
  API: ["/api/**"],
  AUTH_API: ["/api/auth/**"],
  INNGEST_API: ["/api/inngest/**"],
  PROTECTED: ["/form/**", "/admin/**", "/dashboard/**", "/settings/**", "/profile/**"],
  PUBLIC_AUTH: ["/auth/**"],
};

/**
 * Check if a pathname matches any of the given patterns
 */
const isMatchingRoute = (pathname: string, patterns: string[]): boolean =>
  micromatch.isMatch(pathname, patterns);

/**
 * Redirect to a specific URL based on user role and profile
 */
const redirectToDashboard = (req: NextRequest, token: any): NextResponse | null => {
  const { role, consultantProfileId, consulteeProfileId, staffProfileId } = token;
  let redirectUrl = null;

  if (role === 'CONSULTANT' && consultantProfileId) {
    redirectUrl = `/dashboard/consultant/${consultantProfileId}`;
  } else if (role === 'CONSULTEE' && consulteeProfileId) {
    redirectUrl = `/dashboard/consultee/${consulteeProfileId}`;
  } else if (role === 'STAFF' && staffProfileId) {
    redirectUrl = `/dashboard/staff/${staffProfileId}`;
  }

  return redirectUrl ? NextResponse.redirect(new URL(redirectUrl, req.url)) : null;
};

/**
 * Middleware function to handle authentication and authorization for routes.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const token = await getToken({ req });
  const isAuthenticated = !!token;
  const isOnboarded = token?.onboardingCompleted;

  // Handle API routes
  if (isMatchingRoute(pathname, ROUTES.API)) {
    if (isMatchingRoute(pathname, ROUTES.INNGEST_API)) {
      return NextResponse.next();
    }
    if (!isMatchingRoute(pathname, ROUTES.AUTH_API) && !isAuthenticated) {
      return NextResponse.redirect(new URL(URLS.SIGNIN, req.url));
    }
    return NextResponse.next();
  }

  // Handle protected routes
  if (isMatchingRoute(pathname, ROUTES.PROTECTED)) {
    if (!isAuthenticated) {
      return NextResponse.redirect(new URL(URLS.SIGNIN, req.url));
    }

    // Redirect to onboarding if authenticated but not onboarded
    if (!isOnboarded && pathname !== URLS.ONBOARDING) {
      return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
    }

    // Check onboarding status for /form/onboarding route
    if (pathname === URLS.ONBOARDING && isOnboarded) {
      const dashboardRedirect = redirectToDashboard(req, token);
      if (dashboardRedirect) return dashboardRedirect;
    }

    return NextResponse.next();
  }

  // Handle public auth routes
  if (isMatchingRoute(pathname, ROUTES.PUBLIC_AUTH)) {
    if (isAuthenticated) {
      if (!isOnboarded) {
        return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
      }
      const dashboardRedirect = redirectToDashboard(req, token);
      return dashboardRedirect || NextResponse.redirect(new URL(URLS.DASHBOARD, req.url));
    }
    return NextResponse.next();
  }

  if (isAuthenticated && !isOnboarded) {
    return NextResponse.redirect(new URL(URLS.ONBOARDING, req.url));
  }

  // Allow access to all other routes
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
