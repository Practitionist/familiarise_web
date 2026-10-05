import { redirect } from "next/navigation";

import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";
import { getSession } from "@/lib/auth-server";
import { isHostOrgsEnabled } from "@/lib/enterprise/feature-flag";

/**
 * Legacy twin of /dashboard/org-workspace/<id>/create (#1527 §17b). Anyone
 * with a workspace gets sent there (a 307 — the destination is keyed to
 * THIS session's workspace id, so it must never be cached as permanent);
 * only an ORG_WORKSPACE row without one (see layout.tsx — the
 * legacy-backfill guard) still sees the wizard here.
 *
 * Server component so it can read isHostOrgsEnabled() (#863) and hide the host
 * capability when explicitly disabled — the wizard + steps are client components below.
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
      hostOrgsEnabled={isHostOrgsEnabled()}
    />
  );
}
