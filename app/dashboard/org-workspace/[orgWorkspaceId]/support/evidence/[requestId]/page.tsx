import { DashboardEvidencePage } from "@/app/support/_components/DashboardEvidencePage";
export default async function EvidencePage({
  params,
}: Readonly<{
  params: Promise<{ orgWorkspaceId: string; requestId: string }>;
}>) {
  const { orgWorkspaceId, requestId } = await params;
  return (
    <DashboardEvidencePage
      requestId={requestId}
      basePath={`/dashboard/org-workspace/${orgWorkspaceId}`}
    />
  );
}
