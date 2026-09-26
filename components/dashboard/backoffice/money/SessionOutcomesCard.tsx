"use client";

import type { OccurrenceOutcome } from "@prisma/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { SetOutcomeDialog } from "./SetOutcomeDialog";

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

/**
 * #1569 A-10 — sessions the outcome sweep could not decide, and the door that
 * overturns one (D7: a learner who could not get in). It heads the
 * Appointments page, where each booking's own sessions also carry the door.
 */
export function SessionOutcomesCard() {
  const [target, setTarget] = useState<NeedsHumanSession | null>(null);
  const queue = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/sessions/needs-human");
      if (!res.ok) throw new Error("Failed to load");
      return (await res.json()) as { items: NeedsHumanSession[] };
    },
    staleTime: 30_000,
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
        <SetOutcomeDialog
          key={target.id}
          occurrenceId={target.id}
          initial={target.outcome ?? "INCONCLUSIVE"}
          invalidate={[QUEUE_KEY, ["booking-ops"]]}
          onClose={() => setTarget(null)}
        />
      )}
    </Card>
  );
}
