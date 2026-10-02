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

/**
 * #1863 — the refusals this PATCH actually sends a `code` for, and the headline
 * each deserves. Only two branches of the trial route type their answer today
 * (`IllegalTransitionError` at the status transition, `BookingLockUnavailableError`
 * at the lock) — the rest answer 409/400 with a sentence and no code, so they
 * are deliberately NOT invented here. They keep the old "pick another time"
 * handling, which is right for a lost slot and wrong for a moved trial; adding
 * the codes to the route is the fix for those, not a guess at them here.
 */
const TRIAL_REFUSAL_TITLE: Record<string, string> = {
  ILLEGAL_TRANSITION: "This trial has changed since you opened it",
  BOOKING_LOCK_UNAVAILABLE: "The booking system is briefly busy",
};

/**
 * Names the recourse for a failed trial schedule. Branched on `code`, not on
 * the status alone: a 409 is two different facts to the person looking at it
 * (the trial moved, the slot went) and they cannot both be answered with "pick
 * another time" — a stale-tab refusal is fixed by refreshing, and telling
 * someone to pick again sends them round the same loop. The server's sentence
 * stays as the description either way.
 */
function scheduleFailureCopy(error: unknown): {
  title: string;
  description: string;
} {
  if (error instanceof ApiResponseError) {
    const known = error.code ? TRIAL_REFUSAL_TITLE[error.code] : undefined;
    if (known) {
      return {
        title: known,
        description: errorSentence(undefined, error.message),
      };
    }
    return {
      title:
        error.status === 409
          ? "That time is no longer available"
          : "Couldn't schedule trial",
      description:
        error.status === 409
          ? `${errorSentence(undefined, error.message)} Pick another time.`
          : errorSentence(undefined, error.message),
    };
  }
  if (error instanceof Error) {
    return {
      title: "Couldn't schedule trial",
      description: errorSentence(undefined, error.message),
    };
  }
  return {
    title: "Couldn't schedule trial",
    description: "Failed to schedule trial",
  };
}

export interface TrialAcceptTarget {
  id: string;
  consulteeName: string;
  durationMinutes: number;
}

/**
 * "Pick a time" for a trial request — the schedule dialog lifted out of the
 * old Trials tab (#1775): one PATCH takes PENDING → SCHEDULED with the chosen
 * slot, free or paid. The dialog holds while the call is in flight so a second
 * click cannot double-submit (#1705).
 *
 * The paid/free distinction is NOT here. It used to be, as a second toast that
 * branched on the response's `status === "AWAITING_PAYMENT"` — and since #1775
 * made the trial rail payment-before-approval, no path writes that status: the
 * accept handler writes SCHEDULED for a paid trial too, and capture only stamps
 * `Trial.paymentId`. The branch was unreachable, so a consultant could never see
 * the "held while the learner pays" sentence the comment above promised them.
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
      // SyntaxError into the toast instead of the server's reason. The response
      // body is not inspected: there is one outcome (scheduled) and a refusal
      // arrives as a non-2xx, which `requireJsonResponse` throws on.
      await requireJsonResponse(response, "Failed to schedule trial");
    },
    onSuccess: () => {
      // One sentence for both rails. Accepting places the session; on a paid
      // trial the learner has already paid (the order was minted and captured
      // at request), so there is nothing to wait for and no second toast.
      toast({
        title: TOAST.approved,
        description: "The trial is on the calendar.",
      });
      onAccepted();
    },
    onError: (error) => {
      const { title, description } = scheduleFailureCopy(error);
      toast({ title, description, variant: "destructive" });
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
