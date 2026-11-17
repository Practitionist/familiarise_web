import { notFound } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { EvidenceInbox } from "@/components/support/EvidenceInbox";
import { ViewerZone } from "@/app/support/_components/ViewerZone";
export default async function EvidencePage({
  params,
}: Readonly<{ params: Promise<{ orgId: string }> }>) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) notFound();
  return (
    <>
      <PageHeader
        headingLevel={2}
        title="Evidence requests"
        description="Requests addressed to you about sessions sponsored or hosted by this organization."
      />
      <ViewerZone>
        <EvidenceInbox
          organizationId={orgId}
          detailBase={`/dashboard/organization/${orgId}/support/evidence`}
        />
      </ViewerZone>
    </>
  );
}
