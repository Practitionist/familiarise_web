import { NeedsAttentionInbox } from "@/components/dashboard/backoffice/NeedsAttentionInbox";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { requireBackofficePage } from "@/lib/auth-guard";
import { readNeedsAttention } from "@/lib/backoffice/needs-attention";

/** Read-only inbox of stuck work per queue, behind the System Jobs gate. */
export default async function BackofficeNeedsAttentionPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  const { cap } = await requireBackofficePage(
    "systemJobs.manage",
    (await params).tree,
  );
  const queues = await readNeedsAttention();
  return (
    <>
      <PageHeader
        title="Needs attention"
        description="Stuck items in each watched queue, oldest first. Act on them from the linked pages."
      />
      <DashboardContent>
        <NeedsAttentionInbox queues={queues} basePath={cap.basePath} />
      </DashboardContent>
    </>
  );
}
