"use client";

import { useMutation } from "@tanstack/react-query";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";

import {
  TrialScheduleCalendar,
  type SelectedSlot,
} from "./components/TrialScheduleCalendar";
import { TOAST, errorSentence } from "./labels";

/** Narrows the already-parsed trial response without casting. */
function hasDataStatus(value: unknown): value is {
  data?: { status?: string };
} {
  return typeof value === "object" && value !== null && "data" in value;
}

/** Names the recourse for a failed trial schedule without nested ternaries. */
function scheduleFailureCopy(error: unknown): string {
  if (error instanceof ApiResponseError) {
    if (error.status === 409) {
      return `${errorSentence(undefined, error.message)} Pick another time.`;
    }
    return errorSentence(undefined, error.message);
  }
  if (error instanceof Error) return errorSentence(undefined, error.message);
  return "Failed to schedule trial";
}

export interface TrialAcceptTarget {
  id: string;
  consulteeName: string;
  durationMinutes: number;
}

/**
 * "Pick a time" for a trial request — the schedule dialog lifted out of the
 * old Trials tab (#1775): one PATCH takes PENDING → SCHEDULED (free) or
 * AWAITING_PAYMENT (paid) with the chosen slot. The dialog holds while the
 * call is in flight so a second click cannot double-submit (#1705).
 */
export function TrialAcceptDialog({
  consultantId,
  target,
  onOpenChange,
  onAccepted,
}: Readonly<{
  consultantId: string;
  target: TrialAcceptTarget | null;
  onOpenChange: (open: boolean) => void;
  onAccepted: () => void;
}>) {
  const accept = useMutation({
    mutationFn: async (slot: SelectedSlot) => {
      if (!target) throw new Error("No trial selected");
      const response = await fetch(`/api/trials/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "SCHEDULED",
          slotData: {
            startsAt: slot.startsAt.toISOString(),
            endsAt: slot.endsAt.toISOString(),
            availabilityWindowId: slot.availabilityWindowId,
            slotType: slot.slotType,
          },
        }),
      });
      // Never bare response.json(): an edge 504/HTML page would throw a
      // SyntaxError into the toast instead of the server's reason.
      const result = await requireJsonResponse(
        response,
        "Failed to schedule trial",
      );
      return (
        hasDataStatus(result) && result.data?.status === "AWAITING_PAYMENT"
      );
    },
    onSuccess: (awaitingPayment) => {
      // A paid trial is NOT scheduled by accepting — it moves to
      // AWAITING_PAYMENT and the learner gets a pay link.
      toast({
        title: TOAST.approved,
        description: awaitingPayment
          ? "The time is held while the learner pays; it confirms once payment lands and is released if they do not pay in time."
          : "The trial is on the calendar.",
      });
      onAccepted();
    },
    onError: (error) => {
      toast({
        title: "Couldn't schedule trial",
        description: scheduleFailureCopy(error),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && accept.isPending) return;
        onOpenChange(open);
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden">
        <VisuallyHidden>
          <DialogTitle>Pick a time for the trial</DialogTitle>
        </VisuallyHidden>
        {target && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TrialScheduleCalendar
              consultantId={consultantId}
              trialDurationMinutes={target.durationMinutes}
              onSlotSelect={(slot) => accept.mutate(slot)}
              onCancel={() => {
                if (!accept.isPending) onOpenChange(false);
              }}
              isProcessing={accept.isPending}
              consulteeUserName={target.consulteeName}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
