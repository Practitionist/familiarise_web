"use client";

import type { NegativeMoneyOutcome } from "@/lib/booking/misses";
import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { OperatorTime } from "@/lib/time/operator-time";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

/** The session a confirmation is about, as its queue row names it. */
export interface ConfirmSession {
  title: string;
  expert: string;
  /** The 1:1 learner, or a group's attendee count. */
  learner: string;
  startsAt: string;
  /** What the booking is, which decides what a confirmed void sets going. */
  bookingType: string;
  /** A consultation's expert absence still parked as a proposal: confirming runs the no-show claim. */
  proposal: boolean;
}

const VOID_EFFECT: Record<string, string> = {
  CLASS:
    "Confirming starts this voided session's 14 days for a make-up, after which it is refunded. The seats are told, and the miss counts toward their right to leave and the expert's reliability record.",
  WEBINAR:
    "Confirming starts this voided session's 14 days, after which it is refunded.",
  CONSULTATION:
    "Confirming starts this voided session's 14 days, after which the booking is refunded in full.",
  SUBSCRIPTION:
    "Confirming lets this voided session be settled with its plan: it is refunded at the plan's end if it is still unused then.",
};

/** What confirming this verdict sets going, as the confirm door does it. */
export function confirmEffect(
  outcome: NegativeMoneyOutcome,
  session: Pick<ConfirmSession, "bookingType" | "proposal">,
): string {
  if (outcome === "LEARNER_ABSENT") {
    return "The session stays counted as held, with no refund to the learner. Confirming lets the expert's earning for it be released; on a plan, it also stops this verdict holding back the plan's payments.";
  }
  if (session.proposal) {
    return "Confirming cancels the booking, refunds the learner in full and records a strike for the expert.";
  }
  return (
    VOID_EFFECT[session.bookingType] ??
    "Confirming records this voided session's verdict as it stands."
  );
}

/** The `session.confirm-outcome` door: confirms the verdict the operator sees, unchanged. */
export function ConfirmOutcomeDialog({
  occurrenceId,
  outcome,
  session,
  invalidate,
  onClose,
}: Readonly<{
  occurrenceId: string;
  outcome: NegativeMoneyOutcome;
  session: ConfirmSession;
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
      description={`${confirmEffect(outcome, session)} To change the outcome, use Set outcome instead.`}
      confirmLabel="Confirm outcome"
      pending={door.isPending}
      onConfirm={(reason) =>
        door.mutate({
          url: `/api/admin/sessions/${occurrenceId}/confirm`,
          body: { outcome, reason },
        })
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Booking</dt>
        <dd className="font-medium">{session.title}</dd>
        <dt className="text-muted-foreground">Expert</dt>
        <dd>{session.expert}</dd>
        <dt className="text-muted-foreground">Learner</dt>
        <dd>{session.learner}</dd>
        <dt className="text-muted-foreground">Session</dt>
        <dd>
          <OperatorTime value={session.startsAt} />
        </dd>
      </dl>
    </ReasonDialog>
  );
}
