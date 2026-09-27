import { SupportRequestCasePage } from "@/app/support/_components/SupportRequestCasePage";

/** #1527 — an operator's own support request, from the workspace Support page. */
export default async function WorkspaceSupportRequestPage({
  params,
}: Readonly<{ params: Promise<{ orgWorkspaceId: string; caseKey: string }> }>) {
  const { orgWorkspaceId, caseKey } = await params;
  return (
    <SupportRequestCasePage
      caseKey={caseKey}
      supportHref={`/dashboard/org-workspace/${orgWorkspaceId}/support`}
    />
  );
}
