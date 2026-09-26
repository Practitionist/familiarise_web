import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";

import { OrgSupportTriage } from "./OrgSupportTriage";

/**
 * #support-hub — org support triage: CSAT aggregate + members' conversation
 * metadata (never transcripts, ADR 20) + the org-party dispute entry.
 * ORG-12 (#1527): the page now guards `operations.read` on the server like
 * its API routes, instead of only in the client hook.
 */
export default async function OrgSupportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) redirect(`/dashboard/organization/${orgId}/home`);

  return (
    <>
      <DashboardHeader
        title="Support"
        description="How members rate sessions, and the status of their support conversations."
      />
      <DashboardContent>
        <OrgSupportTriage orgId={orgId} />
      </DashboardContent>
    </>
  );
}
