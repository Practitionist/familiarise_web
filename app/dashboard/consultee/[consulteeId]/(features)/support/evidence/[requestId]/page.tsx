import { DashboardEvidencePage } from "@/app/support/_components/DashboardEvidencePage";
export default async function EvidencePage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string; requestId: string }> }>) {
  const { consulteeId, requestId } = await params;
  return (
    <DashboardEvidencePage
      requestId={requestId}
      basePath={`/dashboard/consultee/${consulteeId}`}
    />
  );
}
