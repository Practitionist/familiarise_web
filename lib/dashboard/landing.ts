import { backofficeLandingHref as treeLandingHref } from "@/lib/backoffice/capability";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";
import {
  selectFallbackOrgMembership,
  type FallbackOrgCandidate,
} from "@/lib/labels/org-labels";

/**
 * Where `/dashboard` sends a signed-in user (#1527 §6 Landing). Pure; the one
 * read it needs (the workspace's default org) is `readWorkspaceLandingOrgId`.
 */

export interface LandingUser {
  role: string | null | undefined;
  staffProfileId?: string | null;
  orgWorkspaceProfileId?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  /** The session's ACTIVE memberships of ACTIVE orgs. */
  organizationMemberships?: readonly FallbackOrgCandidate[] | null;
}

/** role=null or no reachable surface: finish onboarding (`/dashboard/error` has no page). */
export const ONBOARDING_HREF = "/form/onboarding";

/** Back-office landing (Q12): admins → Needs attention, staff → Tickets. */
export function backofficeLandingHref(role: "ADMIN" | "STAFF"): string {
  return treeLandingHref({ tree: role === "ADMIN" ? "admin" : "staff" });
}

export function resolveDashboardLanding(
  user: LandingUser,
  options: { workspaceLandingOrgId?: string | null } = {},
): string {
  if (!user.role) return ONBOARDING_HREF;
  if (user.role === "ADMIN" || user.role === "STAFF") {
    return backofficeLandingHref(user.role);
  }
  const memberships = user.organizationMemberships ?? [];

  if (user.role === "ORG_WORKSPACE") {
    // The workspace's default org wins, but only while the user is still an
    // ACTIVE member of it — a stale setting must not strand them on a 403.
    const preferred = options.workspaceLandingOrgId;
    if (preferred && memberships.some((m) => m.organizationId === preferred)) {
      return `/dashboard/organization/${preferred}`;
    }
    // No profile yet (#724) → the create wizard.
    return user.orgWorkspaceProfileId
      ? `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/home`
      : "/dashboard/organization";
  }

  // Consumer identities: the onboarding role's home, then any personal facet,
  // then the highest-ranked org (deterministic across logins).
  let roleHome: string | null = null;
  if (user.role === "CONSULTEE" && user.consulteeProfileId) {
    roleHome = `/dashboard/consultee/${user.consulteeProfileId}/home`;
  } else if (user.role === "CONSULTANT" && user.consultantProfileId) {
    roleHome = `/dashboard/consultant/${user.consultantProfileId}/home`;
  }
  const firstOrg = selectFallbackOrgMembership(memberships)?.organizationId;
  return (
    roleHome ??
    resolvePersonalDashboardHref(user) ??
    (firstOrg ? `/dashboard/organization/${firstOrg}/home` : null) ??
    ONBOARDING_HREF
  );
}

/**
 * The workspace's `defaultLandingOrganizationId` — one read, ORG_WORKSPACE
 * only. Prisma is imported lazily so the pure resolver stays test-importable.
 */
export async function readWorkspaceLandingOrgId(
  user: LandingUser,
): Promise<string | null> {
  if (user.role !== "ORG_WORKSPACE" || !user.orgWorkspaceProfileId) return null;
  const { default: prisma } = await import("@/lib/prisma");
  const profile = await prisma.orgWorkspaceProfile.findUnique({
    where: { id: user.orgWorkspaceProfileId },
    select: { defaultLandingOrganizationId: true },
  });
  return profile?.defaultLandingOrganizationId ?? null;
}
