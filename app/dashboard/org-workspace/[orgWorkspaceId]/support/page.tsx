import { PageHeader } from "@/components/dashboard/PageScaffold";
import { SupportHub } from "@/components/dashboard/shared/support/SupportHub";
export default async function SupportPage({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string }> }>) {
  const { orgWorkspaceId } = await params;
  return (
    <>
      <PageHeader
        headingLevel={2}
        title="Support cases"
        description="Your personal account and workspace requests. Organization-owned cases stay in the selected organization."
      />
      <SupportHub
        requestsBase={`/dashboard/org-workspace/${orgWorkspaceId}/support/requests`}
      />
    </>
  );
}
