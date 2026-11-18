"use client";

/**
 * The one confirmation for ending a collaboration: a manager removing someone
 * from the team, a manager cancelling an invitation, or a collaborator
 * leaving. Each says what happens to access and to money before it is done.
 */

import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/dashboard/ConfirmDialog";
import { useToast } from "@/hooks/use-toast";
import {
  CollaborationRefusal,
  describeRefusal,
  useEndCollaboration,
  type PlanRef,
} from "@/hooks/use-collaborations";
import { REINVITE_COOLDOWN_DAYS } from "@/lib/collaborators/rules";

type EndingKind = "remove" | "cancel" | "leave";

type Copy = {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
  done: string;
};

function copyFor(kind: EndingKind, name: string, planTitle: string): Copy {
  if (kind === "cancel") {
    return {
      title: `Cancel the invitation to ${name}?`,
      lines: [
        `${name} has not accepted, so they have no access to “${planTitle}” and no share of any seat.`,
        "They will be told the invitation was withdrawn. You can invite them again at any time.",
      ],
      confirmLabel: "Cancel invitation",
      cancelLabel: "Keep invitation",
      done: "Invitation cancelled",
    };
  }
  if (kind === "leave") {
    return {
      title: `Leave “${planTitle}”?`,
      lines: [
        "Your access ends now: the sessions, the team chat and each session's chat.",
        "Seats sold while you were on the team keep their split, so you are still paid your share of those.",
        "Seats sold from now on do not include you.",
        `The host will be told. This plan cannot invite you again for ${REINVITE_COOLDOWN_DAYS} days.`,
      ],
      confirmLabel: "Leave",
      cancelLabel: "Stay on the team",
      done: "You have left the team",
    };
  }
  return {
    title: `Remove ${name} from “${planTitle}”?`,
    lines: [
      `${name}'s access ends now: the sessions, the team chat and each session's chat.`,
      "Seats sold while they were on the team keep their split, so they are still paid their share of those.",
      "Seats sold from now on do not include them.",
      "They will be told. To bring them back, send a new invitation.",
    ],
    confirmLabel: "Remove",
    cancelLabel: "Keep on the team",
    done: `${name} has been removed`,
  };
}

export function EndCollaborationDialog({
  kind,
  planRef,
  planTitle,
  collaboratorId,
  personName,
  trigger,
}: Readonly<{
  kind: EndingKind;
  planRef: PlanRef;
  planTitle: string;
  collaboratorId: string;
  /** Whose collaboration ends; unused when the viewer leaves their own. */
  personName: string;
  trigger: ReactNode;
}>) {
  const end = useEndCollaboration(planRef);
  const { toast } = useToast();
  const copy = copyFor(kind, personName, planTitle);

  return (
    // The dialog's own submit stops here, so it never submits a form the trigger sits in.
    <div className="contents" onSubmit={(e) => e.stopPropagation()}>
      <ConfirmDialog
        trigger={trigger}
        title={copy.title}
        confirmLabel={copy.confirmLabel}
        cancelLabel={copy.cancelLabel}
        tone="destructive"
        onConfirm={async () => {
          try {
            await end.mutateAsync(collaboratorId);
            toast({ title: copy.done });
          } catch (error) {
            if (!(error instanceof CollaborationRefusal)) throw error;
            // Someone else ended it first: the outcome asked for already holds.
            if (error.code === "NOT_FOUND") {
              toast({ title: "This collaboration had already ended" });
              return;
            }
            throw new Error(describeRefusal(error).sentence);
          }
        }}
      >
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-foreground">
          {copy.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
