"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { readListBody } from "@/lib/backoffice/money-list-schemas";
import { incidentPhase } from "@/lib/labels/backoffice-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import {
  fromOperatorWallTime,
  toOperatorWallTime,
} from "@/lib/time/operator-zone";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

const QUERY_KEY = ["money-incidents"] as const;
const count = z.number().int().nonnegative();

/** The route's body; a malformed one takes the error path. */
export const incidentsPageSchema = z.object({
  incidents: z.array(
    z.object({
      id: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      reason: z.string(),
      declaredBy: z.string().nullable(),
      createdAt: z.string(),
      enumeratedAt: z.string().nullable(),
      reportedAt: z.string().nullable(),
      settledAt: z.string().nullable(),
      remedies: z.object({
        due: count,
        done: count,
        rebooked: count,
        failed: count,
      }),
    }),
  ),
  total: count,
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  suggestions: z.array(
    z.object({ startsAt: z.string(), endsAt: z.string(), signals: count }),
  ),
});
type IncidentListRow = z.infer<typeof incidentsPageSchema>["incidents"][number];

async function fetchIncidents(page: number) {
  const res = await fetch(`/api/admin/incidents?page=${page}`);
  return readListBody(res, incidentsPageSchema, "Failed to load");
}

/** An IST window as typed, or null while either end is empty or malformed. */
export function incidentWindowBody(startsAt: string, endsAt: string) {
  const start = fromOperatorWallTime(startsAt);
  const end = fromOperatorWallTime(endsAt);
  return start && end
    ? { startsAt: start.toISOString(), endsAt: end.toISOString() }
    : null;
}

/**
 * Declared platform incidents and the hours that look like one. The
 * suggestions never declare anything; an admin declares a window here.
 */
export function IncidentsTab({
  canDeclare,
}: Readonly<{ canDeclare: boolean }>) {
  const [page, setPage] = useState(1);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [declaring, setDeclaring] = useState(false);
  const [settling, setSettling] = useState<IncidentListRow | null>(null);
  const { data, error } = useQuery({
    queryKey: [...QUERY_KEY, page],
    queryFn: () => fetchIncidents(page),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const declare = useOpsDoor({
    success: "Incident declared",
    invalidate: [QUERY_KEY],
    onDone: () => setDeclaring(false),
  });
  const settle = useOpsDoor({
    success: "Settle run finished",
    invalidate: [QUERY_KEY],
    onDone: () => setSettling(null),
  });
  const declared = incidentWindowBody(startsAt, endsAt);
  const windowReady = declared !== null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incidents"
        description="A declared platform outage voids every session it overlaps: no forfeit and no expert strike, and each learner gets a refund, a plan extension, a new trial or the class make-up."
      />
      {canDeclare && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Declare an incident</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="incident-starts">Started (IST)</Label>
              <Input
                id="incident-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="incident-ends">Ended (IST)</Label>
              <Input
                id="incident-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
            <Button disabled={!windowReady} onClick={() => setDeclaring(true)}>
              Declare
            </Button>
            <p className="w-full text-sm text-muted-foreground">
              The window must have ended within the last 7 days and last at most
              24 hours. A declared incident cannot be edited; declare a new one
              to correct it, or overturn one session from its booking.
            </p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Hours that look like an outage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && !data ? (
            <p className="text-sm text-destructive">
              Outage signals could not load.
            </p>
          ) : (data?.suggestions ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hour in the last 7 days stands out from the baseline.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(data?.suggestions ?? []).map((s) => (
                <li
                  key={s.startsAt}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                >
                  <span>
                    <OperatorTime value={s.startsAt} /> to{" "}
                    <OperatorTime value={s.endsAt} />: {s.signals} signals
                  </span>
                  {canDeclare && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setStartsAt(toOperatorWallTime(s.startsAt));
                        setEndsAt(toOperatorWallTime(s.endsAt));
                      }}
                    >
                      Declare this window
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            Signals are unverified or outage session verdicts, unexpected call
            ends and failed webhooks. Nothing here declares an incident.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          {error && !data ? (
            <p className="text-sm text-destructive">
              Incidents could not load.
            </p>
          ) : (data?.incidents ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No incident has been declared.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(data?.incidents ?? []).map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">
                        <OperatorTime value={i.startsAt} /> to{" "}
                        <OperatorTime value={i.endsAt} />
                      </p>
                      <StatusBadge {...incidentPhase(i)} size="sm" />
                    </div>
                    <p className="text-muted-foreground">{i.reason}</p>
                    <p className="text-muted-foreground">
                      Remedies: {i.remedies.due} due, {i.remedies.done} done,{" "}
                      {i.remedies.rebooked} rebooked free, {i.remedies.failed}{" "}
                      need a human
                      {i.declaredBy ? ` · declared by ${i.declaredBy}` : ""}
                    </p>
                  </div>
                  {canDeclare && !i.settledAt && (
                    <Button variant="outline" onClick={() => setSettling(i)}>
                      Run now
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <TablePagination
            className="pt-4"
            page={page}
            pageSize={data?.pageSize ?? 20}
            total={data?.total ?? 0}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
      <ReasonDialog
        open={declaring}
        onOpenChange={(o) => !o && setDeclaring(false)}
        title="Declare a platform incident"
        description="Every session overlapping this window is voided and its learners are made whole. This cannot be undone."
        confirmLabel="Declare"
        pending={declare.isPending}
        canConfirm={windowReady}
        onConfirm={(reason) =>
          declared &&
          declare.mutate({
            url: "/api/admin/incidents",
            body: { ...declared, reason },
          })
        }
      />
      <ReasonDialog
        open={settling !== null}
        onOpenChange={(o) => !o && setSettling(null)}
        title="Run the settle sweep for this incident now"
        description="If the sweep is already running, nothing starts twice."
        confirmLabel="Run"
        pending={settle.isPending}
        onConfirm={(reason) =>
          settling &&
          settle.mutate({
            url: `/api/admin/incidents/${settling.id}/settle`,
            body: { reason },
          })
        }
      />
    </div>
  );
}
