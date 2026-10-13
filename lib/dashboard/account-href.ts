/**
 * #1527 §17b — where "my account" lives for each kind of viewer, now that
 * `/profile` is retired: a personal viewer's Settings › Account (or
 * Notifications), the back office's My profile, a workspace operator's
 * workspace settings. Pure, so the `/profile` redirect and client links
 * share one answer.
 */

import { personalSupportLinks, type SupportLinks } from "./nav/types";

export type AccountSection = "account" | "notifications";

export interface AccountHrefUser {
  role?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  orgWorkspaceProfileId?: string | null;
}

/** The viewer's personal dashboard base; the role's own tree first. */
function personalBase(user: AccountHrefUser): string | null {
  // A dual-profile user lands on the side they signed up as.
  const consultant = user.consultantProfileId
    ? `/dashboard/consultant/${user.consultantProfileId}`
    : null;
  const consultee = user.consulteeProfileId
    ? `/dashboard/consultee/${user.consulteeProfileId}`
    : null;
  return user.role === "CONSULTANT"
    ? (consultant ?? consultee)
    : (consultee ?? consultant);
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
      ? `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/settings/${section}`
      : null;
  }
  const base = personalBase(user);
  return base ? `${base}/settings/${section}` : null;
}

/** #1527 3c — anchor of Settings › Account's "Data consent" section. */
export const DATA_CONSENT_ANCHOR = "data-consent";

/**
 * Where a member grants or withdraws their own org consent (checkout's
 * CONSENT_REQUIRED points here). Null for back-office roles.
 */
export function dataConsentHref(user: AccountHrefUser): string | null {
  if (["ADMIN", "STAFF"].includes(user.role ?? "")) {
    return null;
  }
  const href = accountSettingsHref(user, "account");
  return href ? `${href}#${DATA_CONSENT_ANCHOR}` : null;
}

/**
 * The viewer's own Support requests page (#1527) — never an org's operator
 * triage page. Null for the back office (staff answer requests, they don't
 * file them) and for viewers with no dashboard yet.
 */
export function supportRequestsHref(user: AccountHrefUser): string | null {
  if (user.role === "ADMIN" || user.role === "STAFF") return null;
  if (user.role === "ORG_WORKSPACE") {
    return user.orgWorkspaceProfileId
      ? `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/support`
      : null;
  }
  const base = personalBase(user);
  return base ? `${base}/support` : null;
}

/** The header Help menu rows for a viewer outside their own tree (org context). */
export function supportLinksFor(user: AccountHrefUser): SupportLinks | null {
  const requestsHref = supportRequestsHref(user);
  if (!requestsHref) return null;
  // The workspace page has no Feedback tab.
  return user.role === "ORG_WORKSPACE"
    ? { requestsHref, feedbackHref: null }
    : personalSupportLinks(requestsHref);
}
