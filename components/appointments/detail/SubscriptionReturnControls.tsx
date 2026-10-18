"use client";

import { useMutation } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  RETURN_BLOCK_COPY,
  RETURN_CAP,
  RETURN_CONFIRM_COPY,
  returnBlock,
} from "@/lib/booking/session-return-rules";
import { useViewerZone } from "@/lib/time/use-viewer-zone";
import { formatForViewer } from "@/lib/time/viewer-zone";

interface ReturnableSessionRow {
  id: string;
  startsAt: Date | string;
  completionStatus: string | null;
  isTentative?: boolean | null;
  deletedAt?: Date | string | null;
}

const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

async function postReturn(appointmentId: string, occurrenceId: string) {
  const res = await fetch(
    `/api/appointments/${appointmentId}/occurrences/${occurrenceId}/return`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: "{}",
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    schedulingPeriodEndsAt?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

/**
 * D8 — the consultee's "Return to plan" on each upcoming subscription session.
 * A disabled button says why; the confirm states the rule before anything moves.
 */
export function SubscriptionReturnControls({
  appointmentId,
  sessions,
  sessionsReturned,
  rescheduleOpen,
  onChanged,
}: Readonly<{
  appointmentId: string;
  sessions: ReturnableSessionRow[];
  sessionsReturned: number;
  rescheduleOpen: boolean;
  onChanged: () => void;
}>) {
  const { toast } = useToast();
  const viewer = useViewerZone();
  const when = (d: Date | string) =>
    formatForViewer(toDate(d), viewer, "EEE d MMM, h:mm a");
  const giveBack = useMutation({
    mutationFn: (occurrenceId: string) =>
      postReturn(appointmentId, occurrenceId),
    onSuccess: (data) => {
      toast({
        title: "Session returned to your plan",
        description: data.schedulingPeriodEndsAt
          ? `Your plan now runs until ${formatForViewer(new Date(data.schedulingPeriodEndsAt), viewer, "EEE d MMM")}. Your expert has been told, so a new time can be booked.`
          : "Your expert has been told, so a new time can be booked.",
      });
      onChanged();
    },
    onError: (error: Error) =>
      toast({
        title: "Not returned",
        description: error.message,
        variant: "destructive",
      }),
  });

  const now = new Date();
  const upcoming = sessions.filter(
    (s) =>
      !s.deletedAt &&
      !s.isTentative &&
      (s.completionStatus ?? "SCHEDULED") === "SCHEDULED" &&
      toDate(s.startsAt).getTime() > now.getTime(),
  );
  if (upcoming.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Can&apos;t make a session? Return it to your plan at least 24 hours
        ahead ({sessionsReturned} of {RETURN_CAP} used).
      </p>
      <TooltipProvider>
        {upcoming.map((s) => {
          const block = returnBlock({
            startsAt: s.startsAt,
            now,
            sessionsReturned,
            rescheduleOpen,
          });
          const button = (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!block || giveBack.isPending}
                >
                  Return to plan
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Return this session to your plan?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {RETURN_CONFIRM_COPY}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={() => giveBack.mutate(s.id)}>
                    Return to plan
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
          return (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
            >
              <span>{when(s.startsAt)}</span>
              {block ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>{button}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {RETURN_BLOCK_COPY[block]}
                  </TooltipContent>
                </Tooltip>
              ) : (
                button
              )}
            </div>
          );
        })}
      </TooltipProvider>
    </div>
  );
}
