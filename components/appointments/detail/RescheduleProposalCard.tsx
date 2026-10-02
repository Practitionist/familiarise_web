"use client";

import { useState } from "react";
import { useZonedFormat } from "@/lib/time/zoned-format";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import {
  currentRoundProposedSlots,
  type OpenRescheduleProposal,
} from "@/lib/appointments/consultee-affordances";
import type { RescheduleRespondCode } from "@/lib/booking/reschedule-proposals";

/**
 * The open reschedule proposal on an appointment, with its answers (#1163).
 *
 * Counterparty (session user ≠ initiator) gets Accept + Decline; the
 * initiator gets Withdraw. Decline confirms first, because its one surprise is
 * worth spelling out — and it is not "the times stay with the consultant": since
 * #1846 a decline RESTORES the released sessions to their original times in the
 * common case, and only parks the ones whose original time has since been
 * booked. The dialog therefore describes both outcomes, because which one
 * happens is not knowable before the server has read the rows back; the toast
 * afterwards is driven by the `outcome` the route reports.
 *
 * Toasts relay the SERVER's message: accept runs the full allocator and
 * decline/withdraw are CAS transitions, so what actually happened is decided
 * there, not here. That message is the outcome-specific sentence, which is why
 * the title only has to carry the one case worth distinguishing.
 */

type ProposalAnswer = "accept" | "decline" | "withdraw";

/**
 * Codes the propose route can answer, and what each one means for the person
 * who clicked. Only codes that change what the user does get an entry; the
 * rest fall back to the generic title with the server's sentence as the
 * description, which is still an answer.
 */
const PROPOSAL_REFUSAL_TITLE: Record<string, string> = {
  RESCHEDULE_ALREADY_OPEN: "You already have a reschedule open",
  PROPOSAL_COUNT_MISMATCH: "The proposed times changed",
  PROPOSAL_WINDOW_CLOSED: "The answer window has closed",
  RESCHEDULE_WINDOW: "Too close to the meeting to reschedule",
  BOOKING_LOCK_UNAVAILABLE: "The booking system is briefly busy",
  SESSION_NOT_CANCELLABLE: "This session can no longer be rescheduled",
};

async function postAnswer(
  appointmentId: string,
  kind: ProposalAnswer,
): Promise<{ message?: string; outcome?: RescheduleRespondCode }> {
  const url =
    kind === "withdraw"
      ? `/api/appointments/${appointmentId}/reschedule/withdraw`
      : `/api/appointments/${appointmentId}/reschedule/respond`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(kind === "withdraw" ? {} : { body: JSON.stringify({ action: kind }) }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    message?: string;
    outcome?: RescheduleRespondCode;
    error?: string;
    // #1863 — the refusal's stable half. Every branch of the propose route
    // sends it alongside the sentence: the `Refusal` serialisation
    // (RESCHEDULE_WINDOW), the unique-violation branch
    // (RESCHEDULE_ALREADY_OPEN), the in-transaction pair
    // (PROPOSAL_COUNT_MISMATCH / PROPOSAL_WINDOW_CLOSED) and the typed lock
    // error (BOOKING_LOCK_UNAVAILABLE).
    code?: string;
  };
  if (!res.ok) {
    // #1863 — the sentence was always on the wire; what was thrown away was
    // `code`, which is what distinguishes "you already have one open" from "the
    // window closed" from a lock outage. Carried on the Error rather than
    // flattened into its message, so the toast can title it by code and still
    // relay the server's own sentence as the description.
    throw Object.assign(
      new Error(data.error || "The request could not be completed."),
      { code: data.code },
    );
  }
  return data;
}

const ANSWER_TOAST_TITLE: Record<ProposalAnswer, string> = {
  accept: "New times confirmed",
  decline: "Proposal declined",
  withdraw: "Request withdrawn",
};

interface RescheduleProposalCardProps {
  appointmentId: string;
  proposal: OpenRescheduleProposal;
  /** Which detail page hosts the card — copy only, never authorization. */
  role: "consultee" | "consultant";
  /** Suspended org member (#1527 decision 6): no answers; the API refuses too. */
  readOnly?: boolean;
}

export function RescheduleProposalCard({
  appointmentId,
  proposal,
  role,
  readOnly = false,
}: Readonly<RescheduleProposalCardProps>) {
  const format = useZonedFormat();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [confirmDecline, setConfirmDecline] = useState(false);

  const viewerId = session?.user?.id;
  const isInitiator = !!viewerId && viewerId === proposal.initiatedById;
  const slots = currentRoundProposedSlots(proposal);

  const mutation = useMutation({
    mutationFn: (kind: ProposalAnswer) => postAnswer(appointmentId, kind),
    onSuccess: (data, kind) => {
      setConfirmDecline(false);
      toast({
        title:
          // The one outcome the fixed title would misdescribe: a decline that
          // could not put every released session back leaves real work for the
          // consultant, and "Proposal declined" reads as a clean settle.
          kind === "decline" && data.outcome === "RELEASED"
            ? "Sessions need new times"
            : ANSWER_TOAST_TITLE[kind],
        description: data.message,
      });
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
      // Prefix match — refreshes the events list for every consulteeId/scope.
      void queryClient.invalidateQueries({ queryKey: ["consultee-events"] });
    },
    onError: (error: Error) => {
      setConfirmDecline(false);
      const code = (error as Error & { code?: string }).code;
      toast({
        title: (code && PROPOSAL_REFUSAL_TITLE[code]) || "Error",
        description: error.message,
        variant: "destructive",
      });
      // A 409 usually means the other side answered first — refetch so the
      // card stops offering answers to a settled request.
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
    },
  });
  const busy = mutation.isPending;

  let heading: string;
  if (isInitiator) {
    heading = "You asked to reschedule";
  } else if (proposal.initiatorRole === "CONSULTANT") {
    heading =
      role === "consultee"
        ? "Your consultant proposed new times"
        : "New times were proposed for this booking";
  } else {
    // CONSULTEE-role proposals include org admins acting on the payer side
    // (#1166), so a consultee counterparty must not be told "you asked".
    heading =
      role === "consultant"
        ? "Your consultee asked for new times"
        : "New times were proposed for this booking";
  }

  return (
    <div className="rounded-2xl border border-border border-l-4 border-l-primary bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          {heading}
        </span>
        {proposal.round > 1 && (
          <Badge
            variant="outline"
            className="border-border px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide"
          >
            Counter-offer
          </Badge>
        )}
      </div>

      {slots.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {slots.map((slot) => {
            const startsAt = new Date(slot.startsAt);
            const endsAt = new Date(slot.endsAt);
            return (
              <li
                key={startsAt.toISOString()}
                className="text-sm font-medium tabular-nums text-foreground"
              >
                {format(startsAt, "EEE, d MMM yyyy · h:mm a")}
                <span className="font-normal text-muted-foreground">
                  {" – "}
                  {format(endsAt, "h:mm a")}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No specific time was named — the replacement will be picked on the
          calendar.
        </p>
      )}

      {proposal.reason && (
        <p className="mt-2 text-xs italic text-muted-foreground">
          &ldquo;{proposal.reason}&rdquo;
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        {isInitiator ? "Expires" : "Needs an answer by"}{" "}
        {/* #1863 — `zzz` was missing and the requests inbox has always labelled
            the same deadline for the same booking (InboxRow.formatDateTime).
            Unlabelled, a deadline read on a laptop in a different zone from the
            one the page resolved is indistinguishable from a deadline in the
            viewer's own, and this is the line they act on: miss it and the
            proposal closes. Rendered in the SAME provider zone as the times
            above it, so the card never shows two zones. */}
        {format(new Date(proposal.expiresAt), "EEE, d MMM yyyy · h:mm a zzz")}
      </p>

      {readOnly && (
        <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
          Your organisation membership is suspended, so only your organisation
          can answer this request.
        </p>
      )}

      {viewerId && !readOnly && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {isInitiator ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => mutation.mutate("withdraw")}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Withdraw request
            </Button>
          ) : (
            <>
              {/* Accept needs concrete times; a preference-only request is
                  answered on the calendar (the route 422s it). */}
              {slots.length > 0 && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => mutation.mutate("accept")}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Accept new times
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className="text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/40 dark:hover:bg-red-900/20"
                onClick={() => setConfirmDecline(true)}
              >
                Decline
              </Button>
            </>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmDecline}
        onOpenChange={(open) => !open && setConfirmDecline(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline the proposed times?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  You are only turning down these times — you are not cancelling
                  the booking.
                </p>
                <p className="text-sm text-muted-foreground">
                  {role === "consultee"
                    ? "Your original session times go back on your calendar. If one has been booked by somebody else in the meantime, your consultant places that session at a new time instead."
                    : "The released sessions go back where they were. Any whose original time can no longer be restored stay in your allocate queue to place at new times."}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep deciding</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
              onClick={(event) => {
                // Keep the dialog open while in flight; onSuccess closes it.
                event.preventDefault();
                mutation.mutate("decline");
              }}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Declining...
                </>
              ) : (
                "Decline proposal"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
