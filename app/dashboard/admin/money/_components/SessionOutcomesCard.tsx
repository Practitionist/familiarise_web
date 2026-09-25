"use client";

import type { OccurrenceOutcome } from "@prisma/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

interface NeedsHumanSession {
  id: string;
  startsAt: string;
  outcome: OccurrenceOutcome | null;
  lostMinutes: number | null;
  meeting: { endedReason: string | null } | null;
}

function whyParked(s: NeedsHumanSession): string {
  if (s.meeting?.endedReason === "maintenance") return "Cut by maintenance";
  return s.outcome ? SESSION_OUTCOME_LABEL[s.outcome] : "Not decided";
}

const QUEUE_KEY = ["sessions-needs-human"] as const;
const OUTCOMES = Object.keys(SESSION_OUTCOME_LABEL) as OccurrenceOutcome[];

/**
 * #1569 A-10 — sessions the outcome sweep could not decide, and the door that
 * overturns one (D7: a learner who could not get in). A void that was already
 * made up or refunded is refused by the server.
 */
export function SessionOutcomesCard() {
  const [target, setTarget] = useState<NeedsHumanSession | null>(null);
  const [outcome, setOutcome] = useState<OccurrenceOutcome>("HELD");
  const queue = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/sessions/needs-human");
      if (!res.ok) throw new Error("Failed to load");
      return (await res.json()) as { items: NeedsHumanSession[] };
    },
    staleTime: 30_000,
  });
  const door = useOpsDoor({
    success: "Session outcome updated",
    invalidate: [QUEUE_KEY],
    onDone: () => setTarget(null),
  });
  const items = queue.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Sessions that need a decision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {items.length === 0 && (
          <p className="text-muted-foreground">Nothing is waiting.</p>
        )}
        {items.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              {new Date(s.startsAt).toLocaleString()} · {whyParked(s)}
              {s.lostMinutes ? ` · ${s.lostMinutes} minutes lost` : ""}
            </span>
            <Button size="sm" variant="outline" onClick={() => setTarget(s)}>
              Set outcome
            </Button>
          </div>
        ))}
      </CardContent>
      {target && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setTarget(null)}
          title="Set this session's outcome"
          description="A voided outcome owes the learner a make-up or a refund; a held or forfeit one does not."
          confirmLabel="Set outcome"
          pending={door.isPending}
          onConfirm={(reason) =>
            door.mutate({
              url: `/api/admin/sessions/${target.id}/outcome`,
              body: { outcome, reason },
            })
          }
        >
          <div className="space-y-1.5">
            <Label htmlFor="session-outcome">Outcome</Label>
            <select
              id="session-outcome"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as OccurrenceOutcome)}
            >
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {SESSION_OUTCOME_LABEL[o]}
                </option>
              ))}
            </select>
          </div>
        </ReasonDialog>
      )}
    </Card>
  );
}
