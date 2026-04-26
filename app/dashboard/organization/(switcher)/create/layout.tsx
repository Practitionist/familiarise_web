import { redirect } from "next/navigation";
import { requireUserRole } from "@/lib/auth-guard";

/**
 * /dashboard/organization/create is a backstop, not the primary entry.
 *
 * After the org-admin dashboard consolidation (commits f6876b8e +
 * d2bb6e02), every operator with an OrgAdminProfile uses
 * /dashboard/org-admin/<id>/create — they get the operator chrome,
 * matching cancel target, and consistent visual context.
 *
 * This route still exists for one narrow case: the user has
 * `User.role === "ORG_ADMIN"` but NO `orgAdminProfileId` yet. That
 * window only opens between two writes:
 *   1. setOnboardingRoleAction(userId, "ORG_ADMIN") commits the role
 *   2. POST /api/organizations lazy-creates the profile (line 288)
 *
 * If the user bounces out of the wizard between (1) and (2) and
 * comes back via this URL, we render the unbranded shell so they
 * can finish creation. Once their profile is created, this URL
 * server-redirects them into the operator chrome — making the
 * dashboard the canonical entry for everyone except half-onboarded
 * recoveries.
 *
 * Future roadmap: move the lazy-create from POST /api/organizations
 * into setOnboardingRoleAction, eliminating the half-onboarded
 * window entirely. At that point this route can be deleted. Tracked
 * in the GitHub issue for "collapse half-onboarded ORG_ADMIN state".
 */
export default async function CreateOrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUserRole("ORG_ADMIN");

  if (session.user.orgAdminProfileId) {
    redirect(
      `/dashboard/org-admin/${session.user.orgAdminProfileId}/create`,
    );
  }

  return <>{children}</>;
}
