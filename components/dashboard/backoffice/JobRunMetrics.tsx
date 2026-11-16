"use client";

import Link from "next/link";
import { Bar, BarChart, Tooltip, XAxis } from "recharts";

import { Section } from "@/components/dashboard/Section";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  JobRunMetric,
  JobRunMetrics as Metrics,
  MetricsEnvironment,
} from "@/lib/backoffice/job-run-metrics";
import { OperatorTime } from "@/lib/time/operator-time";
import { toneTextClass, type Tone } from "@/lib/ui/tone";
import { cn } from "@/utils/tailwind";

const OK_FILL = "hsl(var(--muted-foreground))";
const FAIL_FILL = "hsl(var(--destructive))";

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

const WINDOW: Record<
  JobRunMetric["missed"]["state"],
  { label: string; tone: Tone }
> = {
  ok: { label: "On time", tone: "success" },
  missed: { label: "Missed", tone: "critical" },
  unscheduled: { label: "Not scheduled", tone: "neutral" },
  "no-runs": { label: "No runs here", tone: "neutral" },
};

const BASIS: Record<NonNullable<JobRunMetric["missed"]["basis"]>, string> = {
  slo: "freshness budget",
  window: "calendar window",
};

function Sparkline({ job }: Readonly<{ job: JobRunMetric }>) {
  const data = job.daily.map((d) => ({
    day: d.day,
    ok: d.runs - d.failures,
    failures: d.failures,
  }));
  const summary = job.daily
    .map((d) => `${d.day}: ${d.runs} runs, ${d.failures} failed`)
    .join("; ");
  return (
    <div role="img" aria-label={`Daily runs for ${job.jobName}. ${summary}`}>
      <BarChart width={112} height={28} data={data} barCategoryGap={2}>
        <XAxis dataKey="day" hide />
        <Tooltip cursor={false} wrapperStyle={{ zIndex: 20 }} />
        <Bar
          dataKey="ok"
          name="Other runs"
          stackId="runs"
          fill={OK_FILL}
          isAnimationActive={false}
        />
        <Bar
          dataKey="failures"
          name="Failed"
          stackId="runs"
          fill={FAIL_FILL}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </div>
  );
}

/** Links that reload the page for another environment's runs. */
function EnvironmentFilter({
  environment,
  environments,
}: Readonly<{
  environment: MetricsEnvironment;
  environments: readonly MetricsEnvironment[];
}>) {
  return (
    <nav
      className="flex items-center gap-1 text-xs"
      aria-label="Run environment"
    >
      {environments.map((env) => (
        <Link
          key={env}
          href={{ query: { env } }}
          aria-current={env === environment ? "page" : undefined}
          className={cn(
            "rounded-md px-2 py-1",
            env === environment
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {env}
        </Link>
      ))}
    </nav>
  );
}

/** Per-job run health over the last seven days for one environment, from the execution trail. */
export function JobRunMetrics({
  metrics,
  environment,
  environments,
}: Readonly<{
  metrics: Metrics | null;
  environment: MetricsEnvironment;
  environments: readonly MetricsEnvironment[];
}>) {
  const filter = (
    <EnvironmentFilter environment={environment} environments={environments} />
  );
  if (!metrics) {
    return (
      <Section title="Run metrics" variant="card" actions={filter}>
        <p className="text-sm text-muted-foreground">
          The run metrics could not be read. The job list below still works.
        </p>
      </Section>
    );
  }
  const missed = metrics.jobs.filter((j) => j.missed.state === "missed");
  // Most jobs do not record item counts yet; an all-zero column reads as "did nothing".
  const itemsRecorded = metrics.jobs.some((j) => j.itemsProcessed > 0);
  return (
    <Section
      title="Run metrics, last 7 days"
      variant="card"
      description={
        <>
          Every figure counts only runs recorded by the {metrics.environment}{" "}
          environment; the database is shared, so other deploys&apos; runs are
          kept apart.{" "}
          {missed.length > 0
            ? `${missed.length} ${missed.length === 1 ? "job has" : "jobs have"} missed a window.`
            : "No job has missed a window."}
        </>
      }
      actions={
        <div className="flex items-center gap-4">
          {filter}
          <div
            className="flex items-center gap-3 text-xs text-muted-foreground"
            aria-label="Chart legend"
          >
            <span className="inline-flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: OK_FILL }}
              />
              Runs
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: FAIL_FILL }}
              />
              Failed
            </span>
          </div>
        </div>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Succeeded</TableHead>
            <TableHead className="text-right">Attention</TableHead>
            <TableHead className="text-right">Partial</TableHead>
            <TableHead className="text-right">Failed</TableHead>
            <TableHead className="text-right">Held / skipped</TableHead>
            <TableHead className="text-right">Idle skips</TableHead>
            <TableHead className="text-right">p50</TableHead>
            <TableHead className="text-right">p95</TableHead>
            {itemsRecorded && (
              <TableHead className="text-right">Items</TableHead>
            )}
            <TableHead>Last finished</TableHead>
            <TableHead>Window</TableHead>
            <TableHead>Daily</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.jobs.map((job) => (
            <TableRow key={job.jobName}>
              <TableCell className="font-mono text-xs">{job.jobName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {job.runs}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {job.succeeded}
              </TableCell>
              <TableCell
                className={`text-right tabular-nums ${toneTextClass(job.attention > 0 ? "caution" : "neutral")}`}
              >
                {job.attention}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {job.partial}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {job.failed}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {job.held} / {job.skipped}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {job.idleSkips}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {duration(job.p50Ms)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {duration(job.p95Ms)}
              </TableCell>
              {itemsRecorded && (
                <TableCell className="text-right tabular-nums">
                  {job.itemsProcessed}
                </TableCell>
              )}
              <TableCell className="whitespace-nowrap text-xs">
                <OperatorTime
                  value={job.lastSuccessAt}
                  fallback="None recorded"
                />
              </TableCell>
              <TableCell>
                <StatusBadge {...WINDOW[job.missed.state]} variant="dot" />
                {job.missed.basis && (
                  <p className="text-[11px] text-muted-foreground">
                    {BASIS[job.missed.basis]}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <Sparkline job={job} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}
