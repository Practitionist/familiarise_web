import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSession>>>["user"];

const PROFILE_KEY_BY_ROLE: Partial<Record<string, keyof SessionUser>> = {
  CONSULTANT: "consultantProfileId",
  CONSULTEE: "consulteeProfileId",
  STAFF: "staffProfileId",
};

/**
 * Redirect to the stale-session cleanup route, which clears cookies
 * (only possible in Route Handlers) and then redirects to /auth/signin.
 * This prevents the redirect loop where middleware sees a stale cookie
 * and keeps bouncing between /dashboard and /auth/signin.
 */
function redirectWithCookieCleanup(): never {
  redirect("/api/auth/clear-stale-session");
}

/**
 * Check whether the user has the role-specific profile they need.
 * ADMIN has no profile requirement and always returns true.
 */
function hasRequiredProfile(user: SessionUser): boolean {
  const profileKey = PROFILE_KEY_BY_ROLE[user.role];
  return !profileKey || !!user[profileKey];
}

/**
 * A user is fully onboarded when onboardingCompleted is true AND
 * their role-specific profile exists.
 */
function isFullyOnboarded(user: SessionUser): boolean {
  return !!user.onboardingCompleted && hasRequiredProfile(user);
}

/**
 * Require an authenticated session. Redirects to sign-in if no session.
 * Returns the validated session (never null).
 */
export async function requireAuth() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirectWithCookieCleanup();
  }
  return session;
}

/**
 * Require an authenticated AND fully onboarded user.
 * Redirects to sign-in if no session, to onboarding if not completed or
 * profile is missing. Uses disableCookieCache to avoid stale values.
 */
export async function requireOnboarded() {
  const session = await getSession(true);
  if (!session?.user?.id) {
    redirectWithCookieCleanup();
  }
  if (!session.user.onboardingCompleted) {
    redirect("/form/onboarding");
  }
  if (!hasRequiredProfile(session.user)) {
    redirect("/form/onboarding?error=missing_profile");
  }
  return session;
}

/**
 * Require an onboarded user whose `UserRole` is in the allowed set.
 * Use for pages restricted to a specific user type (e.g. `/dashboard/organization/create`
 * for ORG_ADMIN). Sends other roles to the generic dashboard — which in turn
 * routes them to their role-specific home.
 */
export async function requireUserRole(allowed: UserRole | UserRole[]) {
  const session = await requireOnboarded();
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  if (!session.user.role || !roles.includes(session.user.role as UserRole)) {
    redirect("/dashboard");
  }
  return session;
}

/**
 * Require that onboarding is NOT fully completed (for the onboarding page).
 * Redirects fully-onboarded users to their dashboard.
 * Uses disableCookieCache to avoid stale values.
 */
export async function requireNotOnboarded() {
  const session = await getSession(true);
  if (!session?.user?.id) {
    redirectWithCookieCleanup();
  }
  if (isFullyOnboarded(session.user)) {
    redirect("/dashboard");
  }
  return session;
}
