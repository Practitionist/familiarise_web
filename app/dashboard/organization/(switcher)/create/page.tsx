import { redirect } from "next/navigation";

import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";
import { getSession } from "@/lib/auth-server";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

/**
 * Legacy twin of /dashboard/org-workspace/<id>/create (#1527 §17b). Anyone
 * with a workspace gets sent there (a 307 — the destination is keyed to
 * THIS session's workspace id, so it must never be cached as permanent);
 * only an ORG_WORKSPACE row without one (see layout.tsx — the
 * legacy-backfill guard) still sees the wizard here.
 *
 * Server component so it can read ENABLE_HOST_ORGS (#863) and hide the host
 * capability when off — the wizard + steps are client components below.
 */
export default async function CreateOrganizationPage() {
  const session = await getSession(true);
  const workspaceId = session?.user?.orgWorkspaceProfileId;
  if (workspaceId) {
    redirect(`/dashboard/org-workspace/${workspaceId}/create`);
  }
  return (
    <CreateOrganizationWizard
      cancelHref="/dashboard"
      hostOrgsEnabled={ENABLE_HOST_ORGS}
    />
  );
}
