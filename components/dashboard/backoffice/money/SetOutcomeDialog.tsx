"use client";

import type { OccurrenceOutcome } from "@prisma/client";
import { useState } from "react";

import { Label } from "@/components/ui/label";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

const OUTCOMES = Object.keys(SESSION_OUTCOME_LABEL) as OccurrenceOutcome[];

/**
 * #1569 A-10 — the `session.set-outcome` door for one session. A void that was
 * already made up or refunded is refused by the server; expert absent on a
 * consultation cancels the whole booking or voids the one session, with a strike.
 */
export function SetOutcomeDialog({
  occurrenceId,
  initial,
  invalidate,
  onClose,
}: Readonly<{
  occurrenceId: string;
  initial: OccurrenceOutcome;
  invalidate: readonly (readonly unknown[])[];
  onClose: () => void;
}>) {
  const [outcome, setOutcome] = useState<OccurrenceOutcome>(initial);
  const door = useOpsDoor({
    success: "Session outcome updated",
    invalidate,
    onDone: onClose,
  });
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Set this session's outcome"
      description={`A voided outcome owes the learner a make-up or a refund; a held or forfeit one does not. On a 1:1 consultation, "${SESSION_OUTCOME_LABEL.HOST_ABSENT}" records a strike for the expert and does one of two things. When every live session of the booking is expert absent, the booking is cancelled and refunded in full now. Otherwise this one session is voided: the expert has 14 days to make it up, and its share is refunded after that. Where neither fits, the door refuses and says why.`}
      confirmLabel="Set outcome"
      pending={door.isPending}
      onConfirm={(reason) =>
        door.mutate({
          url: `/api/admin/sessions/${occurrenceId}/outcome`,
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
  );
}
