import { notFound } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { OrgSupportTriage } from "../OrgSupportTriage";
export default async function ActivityPage({
  params,
}: Readonly<{ params: Promise<{ orgId: string }> }>) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "operations.read",
  });
  if (access.error) notFound();
  return (
    <>
      <PageHeader
        headingLevel={2}
        title="Member support activity"
        description="Session-quality aggregates and support statuses. Members’ private conversations remain with the platform team."
      />
      <OrgSupportTriage orgId={orgId} />
    </>
  );
}
