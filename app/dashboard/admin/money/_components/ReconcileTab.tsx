"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

interface JobRow {
  key: string;
  label: string;
  description: string;
  last: {
    status: string;
    startedAt: string;
    endedAt: string | null;
    errorCount: number | null;
  } | null;
}

const QUERY_KEY = ["money-reconcile"] as const;

async function fetchJobs(): Promise<{
  jobs: JobRow[];
  ledgerReport: { runAt: string; ok: boolean; scope: string } | null;
}> {
  const res = await fetch("/api/admin/reconcile");
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<Awaited<ReturnType<typeof fetchJobs>>>;
}

function lastRun(job: JobRow): string {
  if (!job.last) return "Never run.";
  const when = new Date(job.last.startedAt).toLocaleString();
  const errors = job.last.errorCount ? `, ${job.last.errorCount} errors` : "";
  return `Last run ${when}: ${job.last.status.toLowerCase()}${errors}.`;
}

/**
 * #1771 K-8 — run a reconcile job now, from the console, under its own cron
 * lock; the line under each job is its latest run.
 */
export function ReconcileTab() {
  const [running, setRunning] = useState<JobRow | null>(null);
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchJobs,
    staleTime: 15_000,
  });
  const door = useOpsDoor({
    success: "Started",
    invalidate: [QUERY_KEY],
    onDone: () => setRunning(null),
  });

  return (
    <Card className="m-4 md:m-6 lg:m-8">
      <CardHeader>
        <CardTitle className="text-lg">Reconcile</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {(data?.jobs ?? []).map((job) => (
            <li
              key={job.key}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{job.label}</p>
                <p className="text-muted-foreground">{job.description}</p>
                <p className="text-muted-foreground">{lastRun(job)}</p>
              </div>
              <Button variant="outline" onClick={() => setRunning(job)}>
                Run now
              </Button>
            </li>
          ))}
        </ul>
        {data?.ledgerReport && (
          <p className="mt-3 text-sm text-muted-foreground">
            Latest ledger report ({data.ledgerReport.scope}):{" "}
            {new Date(data.ledgerReport.runAt).toLocaleString()},{" "}
            {data.ledgerReport.ok ? "clean" : "found drift"}.
          </p>
        )}
      </CardContent>
      <ReasonDialog
        open={running !== null}
        onOpenChange={(o) => !o && setRunning(null)}
        title={`Run ${running?.label ?? "job"} now`}
        description="If it is already running, nothing starts twice."
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
  );
}
