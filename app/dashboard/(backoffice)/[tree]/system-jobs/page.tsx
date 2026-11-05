import { JobRunMetrics } from "@/components/dashboard/backoffice/JobRunMetrics";
import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";
import {
  DashboardContent,
  PageHeader,
} from "@/components/dashboard/PageScaffold";
import { requireBackofficePage } from "@/lib/auth-guard";
import {
  defaultMetricsEnvironment,
  metricsEnvironmentSchema,
  readJobRunMetrics,
  type MetricsEnvironment,
} from "@/lib/backoffice/job-run-metrics";
import { systemJobCards } from "@/lib/cron/job-catalog";

async function metricsOrNull(environment: MetricsEnvironment) {
  try {
    return await readJobRunMetrics(environment);
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
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string }>;
  searchParams: Promise<{ env?: string | string[] }>;
}>) {
  await requireBackofficePage("systemJobs.manage", (await params).tree);
  const environment = metricsEnvironmentSchema
    .catch(defaultMetricsEnvironment())
    .parse((await searchParams).env);
  const metrics = await metricsOrNull(environment);
  return (
    <>
      <PageHeader
        title="System Jobs"
        description="Manually trigger background jobs for data validation and cleanup"
      />
      <DashboardContent>
        <JobRunMetrics
          metrics={metrics}
          environment={environment}
          environments={metricsEnvironmentSchema.options}
        />
        <SystemJobsPanel jobs={systemJobCards()} environment={environment} />
      </DashboardContent>
    </>
  );
}
