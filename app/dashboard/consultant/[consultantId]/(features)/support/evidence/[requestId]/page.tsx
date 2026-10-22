import { DashboardEvidencePage } from "@/app/support/_components/DashboardEvidencePage";
export default async function EvidencePage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string; requestId: string }> }>) {
  const { consultantId, requestId } = await params;
  return (
    <DashboardEvidencePage
      requestId={requestId}
      basePath={`/dashboard/consultant/${consultantId}`}
    />
  );
}
