import type { MemberRole, MemberStatus, OrgStatus } from "@prisma/client";

import {
  MEMBER_ROLE_LABEL,
  MEMBER_STATUS_LABEL,
} from "@/lib/labels/org-labels";

/**
 * Resolve the href for a user's "Personal Dashboard" link.
 *
 * Priority order:
 *   orgWorkspaceProfile  → /dashboard/org-workspace/:id/home
 *   consultantProfile → /dashboard/consultant/:id/home
 *   consulteeProfile  → /dashboard/consultee/:id/home
 *   (none)            → null
 *
 * Operator identity wins over consumer identity so an org-owner who
 * also happens to have a ConsulteeProfile lands on their operator
 * home, not a consumer surface. Consultant wins over consultee so
 * an expert who also consumes content on the platform lands on their
 * earnings surface.
 *
 * Keeping this resolver in one place prevents the drift we saw before
 * (invitations page + OrgContextBar + sidebar each had their own
 * inline ternary, and they disagreed on the null-fallback).
 */

export interface PersonalProfileIds {
  orgWorkspaceProfileId?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
}

export function resolvePersonalDashboardHref(
  user: PersonalProfileIds,
): string | null {
  if (user.orgWorkspaceProfileId) {
    return `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/home`;
  }
  if (user.consultantProfileId) {
    return `/dashboard/consultant/${user.consultantProfileId}/home`;
  }
  if (user.consulteeProfileId) {
    return `/dashboard/consultee/${user.consulteeProfileId}/home`;
  }
  return null;
}

export type DashboardFacetKind =
  | "expert"
  | "client"
  | "workspace"
  | "organization"
  | "admin"
  | "staff";

export interface DashboardFacet {
  kind: DashboardFacetKind;
  /** Stable key: the kind, or `org:<id>` for organizations. */
  key: string;
  label: string;
  href: string;
  /** Organization facets only. */
  organizationId?: string;
  image?: string | null;
  /** Humanized member role ("Owner", "Learner"), never the raw enum. */
  roleLabel?: string;
  /** Set when the org or membership is not ACTIVE ("Pending verification"). */
  statusLabel?: string | null;
}

export interface DashboardFacetMembership {
  organizationId: string;
  organizationName: string;
  organizationLogo?: string | null;
  role: MemberRole;
  /** Membership status; the session only carries ACTIVE ones. */
  status?: MemberStatus;
  orgStatus?: OrgStatus;
}

export interface DashboardFacetInput extends PersonalProfileIds {
  role: string | null | undefined;
  /**
   * `canAddConsultantIdentity(user)` from utils/onboarding-shared, computed by
   * the caller so this label module stays free of the schema/Prisma imports.
   */
  canBecomeExpert?: boolean;
  staffProfileId?: string | null;
  memberships: readonly DashboardFacetMembership[];
}

export interface DashboardFacets {
  you: DashboardFacet[];
  organizations: DashboardFacet[];
  platform: DashboardFacet[];
  actions: {
    /** Where "Create organization" goes, or null when not entitled. */
    createOrganizationHref: string | null;
    /** Where "Become an expert" goes, or null when not entitled. */
    becomeExpertHref: string | null;
  };
}

const ORG_STATUS_LABEL: Record<OrgStatus, string | null> = {
  ACTIVE: null,
  PENDING_VERIFICATION: "Pending verification",
  SUSPENDED: "Suspended",
  DEACTIVATED: "Deactivated",
};

function membershipStatusLabel(m: DashboardFacetMembership): string | null {
  const orgLabel = m.orgStatus ? ORG_STATUS_LABEL[m.orgStatus] : null;
  if (orgLabel) return orgLabel;
  return m.status && m.status !== "ACTIVE"
    ? MEMBER_STATUS_LABEL[m.status]
    : null;
}

/**
 * Every dashboard a user can switch to, grouped You / Organizations / Platform
 * (#1527 Q1). Facets follow capability (which profiles exist), not the single
 * UserRole, so a consultant who also booked sessions sees Client too. Org
 * links go to the bare org route, which lands each role on its own page.
 */
export function resolveDashboardFacets(
  input: DashboardFacetInput,
): DashboardFacets {
  const you: DashboardFacet[] = [];
  if (input.consultantProfileId) {
    you.push({
      kind: "expert",
      key: "expert",
      label: "Expert",
      href: `/dashboard/consultant/${input.consultantProfileId}/home`,
    });
  }
  if (input.consulteeProfileId) {
    you.push({
      kind: "client",
      key: "client",
      label: "Client",
      href: `/dashboard/consultee/${input.consulteeProfileId}/home`,
    });
  }

  const organizations: DashboardFacet[] = [];
  if (input.orgWorkspaceProfileId) {
    organizations.push({
      kind: "workspace",
      key: "workspace",
      label: "All organizations",
      href: `/dashboard/org-workspace/${input.orgWorkspaceProfileId}/home`,
    });
  }
  const seen = new Set<string>();
  for (const m of input.memberships) {
    if (seen.has(m.organizationId)) continue;
    seen.add(m.organizationId);
    organizations.push({
      kind: "organization",
      key: `org:${m.organizationId}`,
      label: m.organizationName,
      href: `/dashboard/organization/${m.organizationId}`,
      organizationId: m.organizationId,
      image: m.organizationLogo ?? null,
      roleLabel: MEMBER_ROLE_LABEL[m.role],
      statusLabel: membershipStatusLabel(m),
    });
  }

  const platform: DashboardFacet[] = [];
  if (input.role === "ADMIN") {
    platform.push({
      kind: "admin",
      key: "admin",
      label: "Admin",
      href: "/dashboard/admin/home",
    });
  }
  if (
    (input.role === "STAFF" || input.role === "ADMIN") &&
    input.staffProfileId
  ) {
    platform.push({
      kind: "staff",
      key: "staff",
      label: "Staff",
      href: `/dashboard/staff/${input.staffProfileId}/home`,
    });
  }

  // Creation lives in the workspace; an ORG_WORKSPACE row without its
  // profile yet uses the legacy backstop route.
  let createOrganizationHref: string | null = null;
  if (input.orgWorkspaceProfileId) {
    createOrganizationHref = `/dashboard/org-workspace/${input.orgWorkspaceProfileId}/create`;
  } else if (input.role === "ORG_WORKSPACE") {
    createOrganizationHref = "/dashboard/organization/create";
  }

  const becomeExpertHref = input.canBecomeExpert
    ? "/form/onboarding?add=CONSULTANT"
    : null;

  return {
    you,
    organizations,
    platform,
    actions: { createOrganizationHref, becomeExpertHref },
  };
}
