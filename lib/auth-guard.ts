import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import {
  lookupSession,
  SessionLookupFailedError,
} from "@/lib/auth-session-lookup";
import prisma from "@/lib/prisma";
import { setSentryIdentityFromSession } from "@/lib/observability/identity";
import { ensureOrgWorkspaceProfile } from "@/lib/profiles/ensure-org-workspace-profile";
import { canAddConsultantIdentity } from "@/utils/onboarding-shared";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import type { BackofficeSurface } from "@/lib/auth/backoffice-permissions";
import {
  backofficeLandingHref,
  can,
  isBackofficeTree,
  resolveBackofficeCapability,
} from "@/lib/backoffice/capability";

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSession>>>["user"];

const PROFILE_KEY_BY_ROLE: Partial<Record<string, keyof SessionUser>> = {
  CONSULTANT: "consultantProfileId",
  CONSULTEE: "consulteeProfileId",
  STAFF: "staffProfileId",
  ORG_WORKSPACE: "orgWorkspaceProfileId",
};

/**
 * Redirect to the stale-session cleanup route, which clears cookies and then
 * redirects to /auth/signin while preserving the intended destination.
 */
async function redirectWithCookieCleanup(): Promise<never> {
  const current = (await headers()).get("x-pathname");
  const safe = safeSameOriginPath(current);
  const selfLoop =
    !safe ||
    safe.startsWith("/auth/") ||
    safe.startsWith("/api/auth/clear-stale-session");
  if (selfLoop) redirect("/api/auth/clear-stale-session");
  redirect(
    `/api/auth/clear-stale-session?callbackUrl=${encodeURIComponent(safe as string)}`,
  );
}

type GuardOptions = { allowUnenrolledOperator?: boolean };

async function resolveGuardSession({
  allowUnenrolledOperator = false,
}: GuardOptions = {}) {
  const lookup = await lookupSession(true);
  if (lookup.kind === "failed")
    throw new SessionLookupFailedError(lookup.cause);
  if (lookup.kind === "none") {
    await redirectWithCookieCleanup();
    throw new SessionLookupFailedError(
      new Error("stale-session cleanup did not redirect"),
    );
  }
  if (
    !allowUnenrolledOperator &&
    isOperatorRole(lookup.session.user.role) &&
    lookup.session.user.twoFactorEnabled !== true
  ) {
    redirect(TWO_FACTOR_SETUP_PATH);
  }
  setSentryIdentityFromSession(lookup.session);
  return lookup.session;
}

function hasRequiredProfile(user: SessionUser): boolean {
  const profileKey = PROFILE_KEY_BY_ROLE[user.role];
  return !profileKey || !!user[profileKey];
}

function isFullyOnboarded(user: SessionUser): boolean {
  return !!user.onboardingCompleted && hasRequiredProfile(user);
}

/**
 * Require an authenticated session. Redirects to sign-in if no session.
 */
export async function requireAuth() {
  const session = await resolveGuardSession();
  if (session.user.banned === true) {
    await redirectWithCookieCleanup();
  }
  return session;
}

async function onboardingRedirectTarget(
  extraParams?: Record<string, string>,
): Promise<string> {
  const params = new URLSearchParams(extraParams);
  const safe = safeSameOriginPath((await headers()).get("x-pathname"));
  if (safe && !safe.startsWith("/form/onboarding")) {
    params.set("callbackUrl", safe);
  }
  const query = params.toString();
  return query ? `/form/onboarding?${query}` : "/form/onboarding";
}

/**
 * Require an authenticated AND fully onboarded user.
 */
export async function requireOnboarded(options: GuardOptions = {}) {
  const session = await resolveGuardSession(options);
  if (session.user.banned === true) {
    await redirectWithCookieCleanup();
  }
  if (!session.user.onboardingCompleted) {
    redirect(await onboardingRedirectTarget());
  }
  if (!hasRequiredProfile(session.user)) {
    if (
      session.user.role === "ORG_WORKSPACE" &&
      !session.user.orgWorkspaceProfileId
    ) {
      const id = await ensureOrgWorkspaceProfile(prisma, session.user.id);
      return {
        ...session,
        user: { ...session.user, orgWorkspaceProfileId: id },
      };
    }
    redirect(await onboardingRedirectTarget({ error: "missing_profile" }));
  }
  return session;
}

/**
 * Require an onboarded user whose `UserRole` is in the allowed set.
 */
export async function requireUserRole(
  allowed: UserRole | UserRole[],
  options: GuardOptions = {},
) {
  const session = await requireOnboarded(options);
  const roles = Array.isArray(allowed) ? allowed : [allowed];
  if (!session.user.role || !roles.includes(session.user.role as UserRole)) {
    redirect("/dashboard");
  }
  return session;
}

/** The one page an operator without enrolled 2FA may open. */
export const TWO_FACTOR_SETUP_PATH = "/auth/two-factor/setup";

/**
 * Require an onboarded STAFF/ADMIN with an enrolled second factor.
 */
export async function requireOperator() {
  const session = await requireUserRole(["ADMIN", "STAFF"]);
  if (session.user.twoFactorEnabled !== true) redirect(TWO_FACTOR_SETUP_PATH);
  return session;
}

/**
 * The enrolment page's guard: an operator who has NOT enrolled yet.
 */
export async function requireOperatorAwaitingTwoFactor() {
  const session = await requireUserRole(["ADMIN", "STAFF"], {
    allowUnenrolledOperator: true,
  });
  if (session.user.twoFactorEnabled === true) redirect("/dashboard");
  return session;
}

/**
 * Require back-office access to a specific surface in one tree.
 */
export async function requireBackofficePage(
  surface: BackofficeSurface,
  tree: string,
) {
  const session = await requireOperator();
  const cap = isBackofficeTree(tree)
    ? resolveBackofficeCapability(session.user.role, tree)
    : null;
  if (!cap) redirect("/dashboard");
  if (!can(cap, surface)) redirect(backofficeLandingHref(cap));
  return { session, cap };
}

/**
 * Require that onboarding is NOT fully completed (for the onboarding page).
 */
export async function requireNotOnboarded() {
  const session = await resolveGuardSession();
  if (isFullyOnboarded(session.user)) {
    const current = (await headers()).get("x-pathname") ?? "";
    const query = current.includes("?")
      ? current.slice(current.indexOf("?"))
      : "";
    const wantsAdd =
      new URLSearchParams(query).get("add") === "CONSULTANT" &&
      canAddConsultantIdentity(session.user);
    if (!wantsAdd) redirect("/dashboard");
  }
  return session;
}
