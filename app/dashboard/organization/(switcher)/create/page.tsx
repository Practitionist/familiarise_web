import { permanentRedirect } from "next/navigation";

import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";
import { getSession } from "@/lib/auth-server";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

/**
 * Legacy twin of /dashboard/org-workspace/<id>/create (#1527 §17b). Anyone
 * with a workspace gets a 308 there; only an ORG_WORKSPACE row without one
 * (see layout.tsx — the legacy-backfill guard) still sees the wizard here.
 *
 * Server component so it can read ENABLE_HOST_ORGS (#863) and hide the host
 * capability when off — the wizard + steps are client components below.
 */
export default async function CreateOrganizationPage() {
  const session = await getSession(true);
  const workspaceId = session?.user?.orgWorkspaceProfileId;
  if (workspaceId) {
    permanentRedirect(`/dashboard/org-workspace/${workspaceId}/create`);
  }
  return (
    <CreateOrganizationWizard
      cancelHref="/dashboard"
      hostOrgsEnabled={ENABLE_HOST_ORGS}
    />
  );
}
