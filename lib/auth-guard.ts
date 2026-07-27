import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

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
 * Build the onboarding redirect target, preserving the intended destination
 * (the path middleware stashed in `x-pathname`) as `?callbackUrl=` so that
 * finishing onboarding returns the user to where they were headed rather than
 * the dashboard. Never loops back to onboarding itself.
 */
async function onboardingRedirectTarget(
  extraParams?: Record<string, string>,
): Promise<string> {
  const params = new URLSearchParams(extraParams);
  const current = (await headers()).get("x-pathname");
  if (
    current &&
    current.startsWith("/") &&
    !current.startsWith("//") &&
    !current.startsWith("/form/onboarding")
  ) {
    params.set("callbackUrl", current);
  }
  const query = params.toString();
  return query ? `/form/onboarding?${query}` : "/form/onboarding";
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
    redirect(await onboardingRedirectTarget());
  }
  if (!hasRequiredProfile(session.user)) {
    redirect(await onboardingRedirectTarget({ error: "missing_profile" }));
  }
  return session;
}

/**
 * Require an onboarded user whose `UserRole` is in the allowed set.
 * Use for pages restricted to a specific user type (e.g. `/dashboard/organization/create`
 * for ORG_WORKSPACE). Sends other roles to the generic dashboard — which in turn
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
 * Require back-office access to a specific surface. The page-level twin of
 * `requireBackofficeSurface` (which returns a 403 for API routes) — this
 * redirects instead, so a STAFF member who types `/dashboard/admin/payouts`
 * lands back on the back-office home rather than seeing a broken page.
 *
 * Every page under `/dashboard/admin` that isn't visible to both roles must
 * call this. The sidebar hiding the link is not access control; it only keeps
 * the nav tidy.
 *
 * @see lib/auth/backoffice-permissions.ts
 */
export async function requireBackofficePage(surface: BackofficeSurface) {
  const session = await requireUserRole(["ADMIN", "STAFF"]);
  if (!hasBackofficePermission(session.user.role as UserRole, surface)) {
    redirect("/dashboard/admin/home");
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
