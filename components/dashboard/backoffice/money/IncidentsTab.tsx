"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/dashboard/PageScaffold";
import type {
  IncidentListRow,
  SuggestedWindow,
} from "@/lib/backoffice/incidents-read";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

const QUERY_KEY = ["money-incidents"] as const;
const WHEN = "d MMM yyyy, hh:mm a";

async function fetchIncidents(): Promise<{
  incidents: IncidentListRow[];
  suggestions: SuggestedWindow[];
}> {
  const res = await fetch("/api/admin/incidents");
  if (!res.ok) throw new Error("Failed to load");
  return res.json() as Promise<Awaited<ReturnType<typeof fetchIncidents>>>;
}

/** An ISO instant as the browser's `datetime-local` value. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusOf(i: IncidentListRow): string {
  if (i.settledAt) return "Settled";
  if (i.enumeratedAt) return "Remedies in progress";
  return "Voiding sessions";
}

/**
 * Declared platform incidents and the hours that look like one. The
 * suggestions never declare anything; an admin declares a window here.
 */
export function IncidentsTab({
  canDeclare,
}: Readonly<{ canDeclare: boolean }>) {
  const zoned = useZonedFormat();
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [declaring, setDeclaring] = useState(false);
  const [settling, setSettling] = useState<IncidentListRow | null>(null);
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchIncidents,
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
  const windowReady = startsAt !== "" && endsAt !== "";

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
              <Label htmlFor="incident-starts">Started</Label>
              <Input
                id="incident-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="incident-ends">Ended</Label>
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
          {(data?.suggestions ?? []).length === 0 ? (
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
                    {zoned(s.startsAt, WHEN)} to {zoned(s.endsAt, WHEN)}:{" "}
                    {s.signals} signals
                  </span>
                  {canDeclare && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setStartsAt(toLocalInput(s.startsAt));
                        setEndsAt(toLocalInput(s.endsAt));
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
          {(data?.incidents ?? []).length === 0 ? (
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
                    <p className="font-medium">
                      {zoned(i.startsAt, WHEN)} to {zoned(i.endsAt, WHEN)} ·{" "}
                      {statusOf(i)}
                    </p>
                    <p className="text-muted-foreground">{i.reason}</p>
                    <p className="text-muted-foreground">
                      Remedies: {i.remedies.due} due, {i.remedies.done} done,{" "}
                      {i.remedies.failed} need a human
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
          declare.mutate({
            url: "/api/admin/incidents",
            body: {
              startsAt: new Date(startsAt).toISOString(),
              endsAt: new Date(endsAt).toISOString(),
              reason,
            },
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
