import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { requireBackofficePage } from "@/lib/auth-guard";

export default async function BackofficeSystemJobsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("systemJobs.manage", (await params).tree);
  return (
    <div className="space-y-6">
      <DashboardHeader
        title="System Jobs"
        subtitle="Manually trigger background jobs for data validation and cleanup"
      />

      <SystemJobsPanel />
    </div>
  );
}
