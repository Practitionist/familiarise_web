import { PageHeader } from "@/components/dashboard/PageScaffold";
import { SupportHub } from "@/components/dashboard/shared/support/SupportHub";
import { ViewerZone } from "@/app/support/_components/ViewerZone";
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
      <ViewerZone>
        <SupportHub
          requestsBase={`/dashboard/org-workspace/${orgWorkspaceId}/support/requests`}
        />
      </ViewerZone>
    </>
  );
}
