/**
 * #1527 §17b — where "my account" lives for each kind of viewer, now that
 * `/profile` is retired: a personal viewer's Settings › Account (or
 * Notifications), the back office's My profile, a workspace operator's
 * workspace settings. Pure, so the `/profile` redirect and client links
 * share one answer.
 */

export type AccountSection = "account" | "notifications";

export interface AccountHrefUser {
  role?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  orgWorkspaceProfileId?: string | null;
}

/** Null when the viewer has no account surface yet (e.g. mid-onboarding). */
export function accountSettingsHref(
  user: AccountHrefUser,
  section: AccountSection = "account",
): string | null {
  if (user.role === "ADMIN") return "/dashboard/admin/settings";
  if (user.role === "STAFF") return "/dashboard/staff/settings";
  if (user.role === "ORG_WORKSPACE") {
    return user.orgWorkspaceProfileId
      ? `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/settings`
      : null;
  }
  // The role's own tree first; a dual-profile user lands on the side they signed up as.
  const consultant = user.consultantProfileId
    ? `/dashboard/consultant/${user.consultantProfileId}/settings/${section}`
    : null;
  const consultee = user.consulteeProfileId
    ? `/dashboard/consultee/${user.consulteeProfileId}/settings/${section}`
    : null;
  return user.role === "CONSULTANT"
    ? (consultant ?? consultee)
    : (consultee ?? consultant);
}
