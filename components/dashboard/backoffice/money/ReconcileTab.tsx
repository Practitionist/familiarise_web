"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { reconcileJobStatus } from "@/lib/labels/backoffice-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

import {
  reconcileOverviewSchema,
  reconcileFeedbackSchema,
  type ReconcileOverview,
  type ReconcileJobRow,
  type ReconcileBatch,
} from "@/schemas/backoffice/reconciliation";

const QUERY_KEY = ["money-reconcile"] as const;

async function fetchJobs(): Promise<ReconcileOverview> {
  const res = await fetch("/api/admin/reconcile");
  if (!res.ok) throw new Error("Failed to load");
  return reconcileOverviewSchema.parse(await res.json());
}

function ledgerVerdict(
  report: NonNullable<ReconcileOverview["ledgerReport"]>,
): string {
  switch (report.status) {
    case "RUNNING":
      return "in progress; continue the audit";
    case "FAILED":
      return "failed to finish; restart the audit";
    case "UNKNOWN":
      return "completion status unavailable";
    case "COMPLETED":
      return report.ok ? "clean" : "found drift";
  }
}

function LastRun({ job }: Readonly<{ job: ReconcileJobRow }>) {
  if (!job.last) return <>Never run.</>;
  const errors = job.last.errorCount ? `${job.last.errorCount} errors` : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      Last run <OperatorTime value={job.last.startedAt} />
      <StatusBadge {...reconcileJobStatus(job.last.status)} size="sm" />
      {errors}
    </span>
  );
}

/** What the last console run of a job did, in the operator's words. */
function batchLine(batch: ReconcileBatch): string {
  return batch.full
    ? `This run processed a full batch of ${batch.limit} — more may remain. Run again to continue.`
    : `This run processed ${batch.processed}.`;
}

export function ReconcileTab() {
  const [running, setRunning] = useState<ReconcileJobRow | null>(null);
  const [lastBatch, setLastBatch] = useState<Record<string, ReconcileBatch>>(
    {},
  );
  const { data, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchJobs,
    staleTime: 15_000,
  });
  const door = useOpsDoor({
    success: "Batch finished",
    invalidate: [QUERY_KEY],
    onDone: (data) => {
      const feedback = reconcileFeedbackSchema.safeParse(data);
      if (feedback.success && feedback.data.batch) {
        const { job, batch } = feedback.data;
        setLastBatch((all) => ({ ...all, [job]: batch }));
      }
      setRunning(null);
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconcile"
        description="Trigger vendor and ledger reconciliation jobs on demand under cron mutual exclusion."
      />
      <Card>
        <CardContent className="pt-6">
          {error && <p role="alert">Could not load reconciliation status.</p>}
          <ul className="divide-y divide-border">
            {(data?.jobs ?? []).map((job) => (
              <li
                key={job.key}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{job.label}</p>
                  <p className="text-muted-foreground">{job.description}</p>
                  <p className="text-muted-foreground">
                    <LastRun job={job} />
                  </p>
                  {lastBatch[job.key] && (
                    <output className="block font-medium">
                      {batchLine(lastBatch[job.key])}
                    </output>
                  )}
                </div>
                <Button variant="outline" onClick={() => setRunning(job)}>
                  {job.key === "ledgers" &&
                  data?.ledgerReport?.status === "RUNNING"
                    ? "Continue audit"
                    : job.key === "ledgers" &&
                        data?.ledgerReport?.status === "FAILED"
                      ? "Restart audit"
                      : "Run now"}
                </Button>
              </li>
            ))}
          </ul>
          {data?.ledgerReport && (
            <p className="mt-3 text-sm text-muted-foreground">
              Latest ledger report ({data.ledgerReport.scope}):{" "}
              <OperatorTime value={data.ledgerReport.runAt} />,{" "}
              {ledgerVerdict(data.ledgerReport)}.
            </p>
          )}
        </CardContent>
        <ReasonDialog
          open={running !== null}
          onOpenChange={(o) => !o && setRunning(null)}
          title={`Run ${running?.label ?? "job"} now`}
          description="Runs one batch. Repeat to continue unfinished work."
          confirmLabel="Run"
          pending={door.isPending}
          onConfirm={(reason) =>
            running &&
            door.mutate({
              url: `/api/admin/reconcile/${running.key}`,
              body: { reason },
            })
          }
        />
      </Card>
    </div>
  );
}
