import { EvidenceInbox } from "@/components/support/EvidenceInbox";
import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";

import { ReportHistory } from "@/components/dashboard/shared/ReportHistory";
import { OrgSupportTriage } from "./OrgSupportTriage";
import { OrgSupportRequests } from "./OrgSupportRequests";

/** Organization correspondence and session activity use separate server-side grants. */
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
            ? "Session quality, member support activity, and your organization’s own requests."
            : "Your organization’s operations and billing requests."
        }
      />
      <DashboardContent>
        <UrlTabs
          tabs={[
            {
              value: "conversations",
              label: "Session support activity",
              content: <OrgSupportTriage orgId={orgId} />,
              show: triage,
            },
            {
              value: "evidence",
              label: "Evidence requests",
              content: <EvidenceInbox />,
            },
            {
              value: "reports",
              label: "Reports and decisions",
              content: <ReportHistory />,
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
