import { notFound } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { DashboardEvidencePage } from "@/app/support/_components/DashboardEvidencePage";
export default async function EvidencePage({
  params,
}: Readonly<{ params: Promise<{ orgId: string; requestId: string }> }>) {
  const { orgId, requestId } = await params;
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) notFound();
  return (
    <DashboardEvidencePage
      requestId={requestId}
      organizationId={orgId}
      basePath={`/dashboard/organization/${orgId}`}
    />
  );
}
