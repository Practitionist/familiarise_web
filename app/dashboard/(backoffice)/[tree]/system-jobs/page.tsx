import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeSystemJobsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("systemJobs.manage", (await params).tree);
  return (
    <>
      <PageHeader
        title="System Jobs"
        description="Manually trigger background jobs for data validation and cleanup"
      />
      <DashboardContent>
        <SystemJobsPanel />
      </DashboardContent>
    </>
  );
}
