/**
 * Resolve the href for a user's "Personal Dashboard" link.
 *
 * Priority order:
 *   orgAdminProfile  → /dashboard/org-admin/:id/home
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
  orgAdminProfileId?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
}

export function resolvePersonalDashboardHref(
  user: PersonalProfileIds,
): string | null {
  if (user.orgAdminProfileId) {
    return `/dashboard/org-admin/${user.orgAdminProfileId}/home`;
  }
  if (user.consultantProfileId) {
    return `/dashboard/consultant/${user.consultantProfileId}/home`;
  }
  if (user.consulteeProfileId) {
    return `/dashboard/consultee/${user.consulteeProfileId}/home`;
  }
  return null;
}
