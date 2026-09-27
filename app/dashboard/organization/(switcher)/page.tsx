/**
 * /dashboard/organization is no longer a standalone "your orgs" list; the
 * portfolio lives at /dashboard/org-workspace/<id>/home. This page only
 * keeps old bookmarks and bell payloads working.
 *
 * RT-D1 (#1527): it used to send an ORG_WORKSPACE user without a workspace
 * profile to /dashboard, whose landing sends that user straight back here —
 * a two-hop loop. Every case now resolves in one redirect:
 *   - workspace profile → the portfolio home
 *   - ORG_WORKSPACE without one (legacy rows, #724) → the create wizard
 *   - anyone else → /dashboard, which routes by role
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-server";

export default async function OrganizationSwitcherRedirect() {
  const session = await getSession(true);
  if (!session?.user?.id) redirect("/auth/signin");

  if (session.user.orgWorkspaceProfileId) {
    redirect(
      `/dashboard/org-workspace/${session.user.orgWorkspaceProfileId}/home`,
    );
  }
  if (session.user.role === "ORG_WORKSPACE") {
    redirect("/dashboard/organization/create");
  }
  redirect("/dashboard");
}
