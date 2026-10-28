import { JobRunMetrics } from "@/components/dashboard/backoffice/JobRunMetrics";
import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { requireBackofficePage } from "@/lib/auth-guard";
import { readJobRunMetrics } from "@/lib/backoffice/job-run-metrics";
import { systemJobCards } from "@/lib/cron/job-catalog";

async function metricsOrNull() {
  try {
    return await readJobRunMetrics();
  } catch (err) {
    console.warn(
      "[system-jobs] run metrics read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export default async function BackofficeSystemJobsPage({
  params,
}: Readonly<{ params: Promise<{ tree: string }> }>) {
  await requireBackofficePage("systemJobs.manage", (await params).tree);
  const metrics = await metricsOrNull();
  return (
    <>
      <PageHeader
        title="System Jobs"
        description="Manually trigger background jobs for data validation and cleanup"
      />
      <DashboardContent>
        <JobRunMetrics metrics={metrics} />
        <SystemJobsPanel jobs={systemJobCards()} />
      </DashboardContent>
    </>
  );
}
