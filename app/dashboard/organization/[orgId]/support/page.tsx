import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";

import { OrgSupportTriage } from "./OrgSupportTriage";
import { OrgSupportRequests } from "./OrgSupportRequests";

/**
 * #support-hub — org Support (#1527), two URL tabs gated apart:
 * Session conversations (`operations.read`): CSAT aggregate + members'
 * conversation metadata (never transcripts, ADR 20) + the org-party dispute
 * entry. Organization requests (`supportRequests.org`, ops OR finance):
 * platform requests members tagged "About" this org.
 * ORG-12 (#1527): the page guards on the server like its API routes.
 */
export default async function OrgSupportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "supportRequests.org",
  });
  if (access.error) redirect(`/dashboard/organization/${orgId}/home`);
  const triage = hasOrgPermission(access.member.role, "operations.read");

  return (
    <>
      <DashboardHeader
        title="Support"
        description={
          triage
            ? "How members rate sessions, their support conversations, and requests raised about this organization."
            : "Requests members raised about this organization."
        }
      />
      <DashboardContent>
        <UrlTabs
          tabs={[
            {
              value: "conversations",
              label: "Session conversations",
              content: <OrgSupportTriage orgId={orgId} />,
              show: triage,
            },
            {
              value: "requests",
              label: "Organization requests",
              content: <OrgSupportRequests orgId={orgId} />,
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
