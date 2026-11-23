"use client";

import type { NegativeMoneyOutcome } from "@/lib/booking/misses";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

/** The `session.confirm-outcome` door: confirms the verdict the operator sees, unchanged. */
export function ConfirmOutcomeDialog({
  occurrenceId,
  outcome,
  invalidate,
  onClose,
}: Readonly<{
  occurrenceId: string;
  outcome: NegativeMoneyOutcome;
  invalidate: readonly (readonly unknown[])[];
  onClose: () => void;
}>) {
  const door = useOpsDoor({
    success: "Outcome confirmed",
    invalidate,
    onDone: onClose,
    refusalCopy: {
      SESSION_MOVED: "This session's outcome changed since you opened it.",
    },
  });
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Confirm "${SESSION_OUTCOME_LABEL[outcome]}"`}
      description="Confirms the recorded outcome as it stands, so its money effect can go ahead. To change the outcome, use Set outcome instead."
      confirmLabel="Confirm outcome"
      pending={door.isPending}
      onConfirm={(reason) =>
        door.mutate({
          url: `/api/admin/sessions/${occurrenceId}/confirm`,
          body: { outcome, reason },
        })
      }
    />
  );
}
