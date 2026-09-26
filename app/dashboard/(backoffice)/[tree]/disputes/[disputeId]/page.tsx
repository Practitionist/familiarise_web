import { DisputeDetailPage } from "@/components/dashboard/shared/DisputeDetailPage";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeDisputeDetailPage({
  params,
}: Readonly<{ params: Promise<{ tree: string; disputeId: string }> }>) {
  const { tree, disputeId } = await params;
  // Page-level back-office gate (C5): sidebar hiding is not access control.
  await requireBackofficePage("disputes.read", tree);
  return (
    <DisputeDetailPage
      disputeId={disputeId}
      apiEndpoint="/api/admin/disputes"
    />
  );
}
