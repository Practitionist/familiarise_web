import { redirect } from "next/navigation";
import { requireUserRole } from "@/lib/auth-guard";

/**
 * /dashboard/organization/create is a backstop, not the primary entry.
 *
 * After the org-workspace dashboard consolidation (commits f6876b8e +
 * d2bb6e02), every operator with an OrgWorkspaceProfile uses
 * /dashboard/org-workspace/<id>/create — they get the operator chrome,
 * matching cancel target, and consistent visual context.
 *
 * This route still exists for one narrow case: the user has
 * `User.role === "ORG_WORKSPACE"` but NO `orgWorkspaceProfileId` yet. New
 * handoffs no longer open this window — `setOnboardingRoleAction` creates +
 * links the profile, and `PROFILE_KEY_BY_ROLE` enforces it — but rows
 * written before that change (or with the profile unlinked by a
 * `resetOnboardingRoleAction` re-entry edge) still land here.
 *
 * If such a user comes back via this URL, we render the unbranded shell so
 * they can finish creation. Once their profile is created, this URL
 * server-redirects them into the operator chrome — making the
 * dashboard the canonical entry for everyone except half-onboarded
 * recoveries. Do NOT delete this route until the backfill for legacy rows
 * has run; the roadmap item to move the lazy-create into the handoff is
 * done, this shell is what remains for the old rows.
 */
export default async function CreateOrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUserRole("ORG_WORKSPACE");

  if (session.user.orgWorkspaceProfileId) {
    redirect(
      `/dashboard/org-workspace/${session.user.orgWorkspaceProfileId}/create`,
    );
  }

  return <>{children}</>;
}
