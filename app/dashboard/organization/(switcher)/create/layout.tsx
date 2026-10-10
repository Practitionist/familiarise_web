import { requireUserRole } from "@/lib/auth-guard";

/**
 * /dashboard/organization/create is a backstop, not the primary entry:
 * operators with an OrgWorkspaceProfile use /dashboard/org-workspace/<id>/create.
 *
 * It serves an ORG_WORKSPACE user with no `orgWorkspaceProfileId` (legacy
 * rows; new owners get the profile inside the org-create transaction). Once
 * the profile exists this URL answers a temporary 307 into the operator
 * chrome, since the redirect is session-keyed.
 */
export default async function CreateOrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Role gate only; the page 307s anyone who has a workspace (#1527).
  await requireUserRole("ORG_WORKSPACE");
  return <>{children}</>;
}
