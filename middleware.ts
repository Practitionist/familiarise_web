import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import micromatch from "micromatch";
import prisma from "./lib/prisma";

// Constants for common URLs
const SIGNIN_URL = "/auth/signin";
const DASHBOARD_URL = "/dashboard";

// Route patterns
const API_ROUTES = ["/api/**"];
const AUTH_API_ROUTES = ["/api/auth/**"];
const INNGEST_API_ROUTES = ["/api/inngest/**"];
const PROTECTED_ROUTES = ["/form/**", "/admin/**", "/dashboard/**", "/settings/**", "/profile/**"];
const PUBLIC_AUTH_ROUTES = ["/auth/**"];

/**
 * Check if a pathname matches any of the given patterns
 * @param pathname The pathname to check
 * @param patterns Array of glob patterns to match against
 * @returns boolean indicating if the pathname matches any pattern
 */
const isMatchingRoute = (pathname: string, patterns: string[]): boolean => {
  return micromatch.isMatch(pathname, patterns);
};

/**
 * Middleware function to handle authentication and authorization for routes.
 * @param req The NextRequest object representing the incoming request.
 * @returns The appropriate NextResponse object based on the authentication and authorization rules.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const token = await getToken({ req });
  const isAuthenticated = !!token;

  // Handle API routes
  if (isMatchingRoute(pathname, API_ROUTES)) {
    // Handle Inngest API routes
    if (isMatchingRoute(pathname, INNGEST_API_ROUTES)) {
      return NextResponse.next();
    }
    if (!isMatchingRoute(pathname, AUTH_API_ROUTES) && !isAuthenticated) {
      return NextResponse.redirect(new URL(SIGNIN_URL, req.url));
    }
    return NextResponse.next();
  }

  // Handle protected routes
  if (isMatchingRoute(pathname, PROTECTED_ROUTES)) {
    if (!isAuthenticated) {
      return NextResponse.redirect(new URL(SIGNIN_URL, req.url));
    }

    // Check onboarding status for /form/onboarding route
    if (pathname === '/form/onboarding') {

      const onboardingCompleted = token.onboardingCompleted;
      const role = token.role;
      
      const consultantProfileId = token.consultantProfileId;
      const consulteeProfileId = token.consulteeProfileId;
      const staffProfileId = token.staffProfileId;

      if (onboardingCompleted) {
        if (role === 'CONSULTANT' && consultantProfileId) {
          return NextResponse.redirect(new URL(`/dashboard/consultant/${consultantProfileId}`, req.url));
        } else if (role === 'CONSULTEE' && consulteeProfileId) {
          return NextResponse.redirect(new URL(`/dashboard/consultee/${consulteeProfileId}`, req.url));
        } else if (role === 'STAFF' && staffProfileId) {
          return NextResponse.redirect(new URL(`/dashboard/staff/${staffProfileId}`, req.url));
        }
      }
    }

    return NextResponse.next();
  }

  // Handle public auth routes
  if (isMatchingRoute(pathname, PUBLIC_AUTH_ROUTES)) {
    return isAuthenticated
      ? NextResponse.redirect(new URL(DASHBOARD_URL, req.url))
      : NextResponse.next();
  }

  // Allow access to all other routes
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api|trpc)(.*)"],
};
