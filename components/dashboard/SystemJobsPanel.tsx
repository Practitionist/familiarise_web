"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/utils/tailwind";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { AdminRunRequests } from "@/components/dashboard/AdminRunRequests";
import {
  JOB_CATEGORIES,
  type JobCategory,
  type SystemJobCard,
} from "@/lib/cron/job-categories";
import type { Tone } from "@/lib/ui/tone";
import { OperatorTime } from "@/lib/time/operator-time";
import type { MetricsEnvironment } from "@/lib/backoffice/job-run-metrics";
import {
  formatDuration,
  isStandDownOutcome,
  outcomeLabel,
  scalarFields,
  summaryFields,
} from "@/lib/cron/run-display";
import {
  CreditCard,
  Clock,
  RefreshCw,
  AlertTriangle,
  DollarSign,
  Calendar,
  Wallet,
  Play,
  Loader2,
  Trash2,
  Database,
  Bell,
  History,
  Receipt,
  ShieldCheck,
  Mail,
  Video,
  LifeBuoy,
} from "lucide-react";

const CATEGORY_ICONS: Record<JobCategory, typeof CreditCard> = {
  Payments: CreditCard,
  Refunds: RefreshCw,
  Disputes: AlertTriangle,
  Earnings: DollarSign,
  Payouts: Wallet,
  Billing: Receipt,
  Compliance: ShieldCheck,
  Appointments: Calendar,
  Messaging: Mail,
  Recordings: Video,
  Support: LifeBuoy,
  Reconciliation: Database,
  Alerts: Bell,
  Cleanup: Trash2,
};

const EXECUTION_STATUS: Record<
  JobExecution["status"],
  { label: string; tone: Tone }
> = {
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "critical" },
  RUNNING: { label: "Running", tone: "info" },
  CANCELLED: { label: "Stood down", tone: "neutral" },
};

/** A completed run that flagged findings with no item failing. */
const NEEDS_ATTENTION: { label: string; tone: Tone } = {
  label: "Needs attention",
  tone: "caution",
};

interface JobCardProps {
  job: SystemJobCard;
  isRunning: boolean;
  onRun: () => void;
}

function JobCard({ job, isRunning, onRun }: JobCardProps) {
  const Icon = CATEGORY_ICONS[job.category];

  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      className="relative overflow-hidden rounded-xl border border-border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <Icon className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground text-sm">
                {job.title}
              </h3>
              <span className="inline-block mt-0.5 px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                {job.category}
              </span>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            {job.description}
          </p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
            <Clock className="h-3.5 w-3.5" />
            <span title={job.scheduleUtc}>{job.schedule}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-border">
        {job.runBlocked ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* aria-disabled, not disabled: a disabled button is unfocusable and fires no pointer events, so the tooltip would never show. */}
                <Button
                  size="sm"
                  variant="outline"
                  aria-disabled="true"
                  className="w-full cursor-not-allowed opacity-50"
                >
                  <Play className="mr-2 h-4 w-4" />
                  Run Now
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {job.runBlocked}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={onRun}
            disabled={isRunning}
            className="w-full"
          >
            {isRunning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Run Now
              </>
            )}
          </Button>
        )}
      </div>
    </motion.div>
  );
}

interface JobExecution {
  id: string;
  jobId: string;
  jobName: string;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  itemsProcessed: number | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  triggeredBy: {
    name: string | null;
  };
}

interface SystemJobsPanelProps {
  className?: string;
  /** Built on the server from the cleanup registry. */
  jobs: SystemJobCard[];
  /** Recent executions list only this environment's runs. */
  environment: MetricsEnvironment;
}

export function SystemJobsPanel({
  className,
  jobs,
  environment,
}: Readonly<SystemJobsPanelProps>) {
  const [runningJobs, setRunningJobs] = useState<Set<string>>(new Set());
  const [executions, setExecutions] = useState<JobExecution[]>([]);
  const [loadingExecutions, setLoadingExecutions] = useState(true);
  const [requestsKey, setRequestsKey] = useState(0);
  const { toast } = useToast();

  // Only the latest request may set state, so a slower answer for a previous environment is dropped.
  const latestExecutionsRequest = useRef(0);
  const fetchExecutions = useCallback(async () => {
    const request = ++latestExecutionsRequest.current;
    try {
      setLoadingExecutions(true);
      const response = await fetch(
        `/api/staff/system-jobs/executions?limit=10&environment=${environment}`,
      );
      if (!response.ok) throw new Error("Failed to fetch executions");
      const data = await response.json();
      if (request === latestExecutionsRequest.current)
        setExecutions(data.executions || []);
    } catch (error) {
      console.error("Error fetching executions:", error);
    } finally {
      if (request === latestExecutionsRequest.current)
        setLoadingExecutions(false);
    }
  }, [environment]);

  useEffect(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  // #1527 Q10 — every "Run now" asks for a reason (the route writes it to the
  // audit log); a money job also needs a typed confirmation.
  const [confirmJob, setConfirmJob] = useState<SystemJobCard | null>(null);
  // One key per Run click; a retry from the same dialog reuses it, so the server returns the same request.
  const [runKey, setRunKey] = useState("");

  const handleRunJob = async (
    job: SystemJobCard,
    reason: string,
    idempotencyKey: string,
  ) => {
    setRunningJobs((prev) => new Set(prev).add(job.id));

    try {
      const response = await fetch("/api/admin/system-jobs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, reason, idempotencyKey }),
      });

      const result = await response.json();
      const runOutcome = response.headers.get("x-run-outcome");

      if (!response.ok && isStandDownOutcome(runOutcome)) {
        toast({
          title: `${job.title} ${outcomeLabel(runOutcome)?.toLowerCase() ?? "skipped"}`,
          description: result.error ?? "The job did not run.",
          variant: "default",
        });
        return;
      }

      if (!response.ok) {
        // Shown inside the dialog, which stays open.
        throw new Error(result.error || "Failed to run job");
      }

      // #1846 N6 — the payout jobs answer 202 and finish after the response.
      if (result.dispatched) {
        if (result.requestId) setRequestsKey((key) => key + 1);
        toast({
          title: `${job.title} ${result.accepted ? "queued" : "started"}`,
          description: result.message,
          variant: "default",
        });
        return;
      }

      const outcome = outcomeLabel(runOutcome);
      const counts = scalarFields(result, 5);
      const failed = outcome === "Failed" || outcome === "Partial";

      toast({
        title: `${job.title} ${outcome?.toLowerCase() ?? "completed"}`,
        description:
          counts.length > 0 ? counts.join(" | ") : (outcome ?? "Job finished"),
        variant: failed ? "destructive" : "default",
      });

      // Check for critical alerts
      if (result.alreadyPaidCount > 0) {
        toast({
          title: "CRITICAL: Manual Recovery Required",
          description: `${result.alreadyPaidCount} earnings were already PAID when dispute was lost`,
          variant: "destructive",
        });
      }
    } finally {
      setRunningJobs((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      fetchExecutions();
    }
  };

  const categories = JOB_CATEGORIES.filter((category) =>
    jobs.some((job) => job.category === category),
  );
  const jobsIn = (category: JobCategory) =>
    jobs.filter((job) => job.category === category);

  return (
    <div className={cn("space-y-8", className)}>
      <AdminRunRequests refreshKey={requestsKey} />

      {/* Recent Executions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Recent Executions
              </CardTitle>
              <CardDescription>
                Last 10 job executions in {environment}
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchExecutions}
              disabled={loadingExecutions}
            >
              <RefreshCw
                className={`h-4 w-4 ${loadingExecutions ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingExecutions ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/70" />
            </div>
          ) : executions.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No recent executions
            </p>
          ) : (
            <div className="space-y-2">
              {executions.map((execution) => (
                <div
                  key={execution.id}
                  className="flex flex-col gap-2 p-3 rounded-lg border border-border sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">
                        {execution.jobName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        by {execution.triggeredBy?.name || "System"} •{" "}
                        <OperatorTime value={execution.startedAt} />
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground/70">
                      {[
                        outcomeLabel(execution.result?.outcome),
                        ...summaryFields(execution.result, 3),
                        execution.itemsProcessed !== null
                          ? `items: ${execution.itemsProcessed}`
                          : null,
                        execution.durationMs !== null
                          ? formatDuration(execution.durationMs)
                          : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                    <StatusBadge
                      {...(execution.status === "COMPLETED" &&
                      execution.result?.outcome === "attention"
                        ? NEEDS_ATTENTION
                        : EXECUTION_STATUS[execution.status])}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job Categories */}
      {categories.map((category) => (
        <div key={category}>
          <div className="flex items-center gap-2 mb-4">
            {(() => {
              const Icon = CATEGORY_ICONS[category];
              return <Icon className="h-5 w-5 text-muted-foreground/70" />;
            })()}
            <h2 className="text-fluid-xl font-semibold tracking-tight text-foreground">
              {category}
            </h2>
            <span className="text-sm text-muted-foreground/70">
              ({jobsIn(category).length} jobs)
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {jobsIn(category).map((job) => (
              <JobCard
                key={job.id}
                job={job}
                isRunning={runningJobs.has(job.id)}
                onRun={() => {
                  setRunKey(crypto.randomUUID());
                  setConfirmJob(job);
                }}
              />
            ))}
          </div>
        </div>
      ))}

      {confirmJob && (
        <ConfirmDialog
          key={confirmJob.id}
          open
          onOpenChange={(open) => !open && setConfirmJob(null)}
          title={`Run ${confirmJob.title} now?`}
          description={`${confirmJob.description}. Schedule: ${confirmJob.schedule}.`}
          confirmLabel="Run now"
          tone={confirmJob.confirmPhrase ? "destructive" : "default"}
          requireReason={{ label: "Why run it by hand?" }}
          requireTyped={confirmJob.confirmPhrase ?? undefined}
          onConfirm={async ({ reason }) => {
            await handleRunJob(confirmJob, reason ?? "", runKey);
            setConfirmJob(null);
          }}
        />
      )}
    </div>
  );
}
