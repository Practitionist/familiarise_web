"use client";

import { useState } from "react";
import {
  ApiResponseError,
  actionFailureMessage,
  requireJsonResponse,
} from "@/lib/fetch-helpers";
import { isExpectedRefusal } from "@/lib/errors/client-refusal";
import { reportSentryError } from "@/lib/observability/report";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { AppointmentOccurrence } from "@prisma/client";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableOccurrence as getJoinableOccurrenceShared,
} from "@/lib/appointments/occurrences";
import type { SlotPreference } from "@/components/scheduling/time-picker-policy";
import {
  applyRefundRequote,
  paymentLandedUnderClick,
  cancelPreviewQueryKey,
  cancelAlreadySettled,
  cancelPreviewUrl,
  cancelRefusalFrom,
  readRefundQuoteChanged,
  refundChangedToast,
  shownQuoteBody,
  type ShownCancelQuote,
} from "@/lib/appointments/cancel-requote";
import { FREE_BOOKING_REFUND_LINE } from "@/lib/appointments/payment-display";
import { codedRefusalToast } from "@/lib/errors/mapping/payment-error-toast-map";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import {
  rescheduleTimesTaken,
  takenStartsFrom,
} from "@/lib/scheduling/allocationMessages";
import { takenSlotStartsOf } from "@/lib/scheduling/allocationService";
import type { RescheduleProposeCode } from "@/lib/booking/reschedule-proposals";

interface UseEventActionsOptions {
  appointmentId?: string;
  rawOccurrences: AppointmentOccurrence[];
  title: string;
  consultant: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
  /** #1163 — the org detail route has no `[consulteeId]` param, so a caller
   * that resolved the id another way must thread it or invalidation no-ops. */
  consulteeId?: string;
}

/**
 * One report shape for both write actions on this page.
 *
 * These two catch blocks used to send whatever they caught at error level, and
 * because both parsed the body before checking `res.ok`, an HTML error page
 * arrived as `SyntaxError: Unexpected token '<'` — in Sentry and in the toast
 * (FAMILIARISE_WEB-1C). With the status carried on the error, a 4xx is a server
 * ANSWER rather than a fault, and everything with a status reports at warning.
 */
function reportActionFailure(error: unknown, op: string): void {
  // A refusal (the reschedule window, a 409 on cancel) is the server's answer;
  // the toast shows it and Sentry never hears of it (FAMILIARISE_WEB-2Z).
  if (isExpectedRefusal(error)) return;
  const status = error instanceof ApiResponseError ? error.status : undefined;
  reportSentryError(error, {
    subsystem: "client",
    op,
    expected: status !== undefined && status >= 400 && status < 500,
    ...(status !== undefined ? { level: "warning" as const } : {}),
    extra: { httpStatus: status },
  });
}

/**
 * The reschedule toast. The server's outcome code picks the title and its
 * sentence is the reason, so a move waiting for acceptance reads as sent.
 */
function rescheduleOutcomeToast(outcome: {
  code: RescheduleProposeCode | undefined;
  message: string | undefined;
  sessionsAffected: number;
}): { title: string; description: string } {
  if (outcome.code === "AUTO_CONFIRMED") {
    return {
      title: "New time confirmed",
      description: "Your session has been moved. Nothing further is needed.",
    };
  }
  if (outcome.code === "AWAITING_ANSWER" && outcome.message) {
    return { title: "Request sent", description: outcome.message };
  }
  if (
    (outcome.code === "NOT_PLACEABLE" || outcome.code === "PROPOSAL_CLOSED") &&
    outcome.message
  ) {
    return { title: "Time not confirmed", description: outcome.message };
  }
  return {
    title: "Ready to reschedule",
    description:
      outcome.sessionsAffected === 1
        ? "Your consultant will pick a new time for your session."
        : `Your consultant will pick new times for your ${outcome.sessionsAffected} sessions.`,
  };
}

/** What the cancel route reports about the money, in the buyer's words. */
type CancelRefund = {
  amountRefundedPaise: number;
  refundPct: number;
  status?:
    "REFUNDED" | "PENDING" | "FAILED" | "NOTHING_REFUNDABLE" | "POLICY_ZERO";
  requiresManualReview?: boolean;
  /**
   * Which rail returned the money. The cancel route has answered this since
   * #1325 and the toast ignored it, so an org-funded learner — whose card was
   * never charged — was told a refund was on its way back to them.
   */
  rail?: "GATEWAY" | "INTERNAL" | "CREDITS";
} | null;

function describeRefund(refund: CancelRefund, freeBooking = false): string {
  // A free booking has no money to speak about.
  if (!refund) return "";
  if (freeBooking) return FREE_BOOKING_REFUND_LINE;

  // Branch on what the route SAYS happened, never on the amount: zero is
  // equally "the policy owes nothing", "the balance was already exhausted" and
  // "the gateway refused", and only one of those deserves an apology.
  switch (refund.status) {
    // #1775 P-3 — the gateway call is unconfirmed; reconcile settles it.
    case "PENDING":
      return "Refund pending — we're confirming with the bank.";
    case "FAILED":
      return "We could not complete your refund automatically — our team has been alerted and will sort it out.";
    case "NOTHING_REFUNDABLE":
      // No alert was raised here, so do not claim one was.
      return "This booking had already been refunded, so there is nothing further to return.";
    case "POLICY_ZERO":
      return "No refund applies under the cancellation policy for this booking.";
    default:
      break;
  }

  // An org-funded booking reverses in the ledger against the org's wallet,
  // invoice or licence — the learner's card was never charged, so "on its way
  // back to you" is a promise nobody kept. Checked before the credit sentence so
  // an internal reversal can never be described as a referral credit.
  if (refund.rail === "INTERNAL") {
    return "The refund goes back to your organisation's account.";
  }

  // #1500 — a credit-funded booking settles as a REFUNDED restoration that moves no
  // gateway money, so the amount is legitimately zero and the sentence has to come
  // from the status rather than the number.
  if (refund.status === "REFUNDED" && refund.amountRefundedPaise === 0) {
    return "Your referral credit has been restored in full.";
  }

  if (refund.amountRefundedPaise > 0) {
    const rupees = (refund.amountRefundedPaise / 100).toLocaleString("en-IN", {
      maximumFractionDigits: 2,
    });
    return `A refund of ₹${rupees} (${refund.refundPct}%) is on its way back to you.`;
  }
  return "";
}

export function useEventActions({
  appointmentId,
  rawOccurrences,
  title,
  consultant: _consultant,
  type,
  consulteeId: consulteeIdOverride,
}: UseEventActionsOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = useParams<{ consulteeId: string }>();
  const router = useRouter();
  // Caller's resolved id first: on the org detail route the param is absent,
  // and trusting it alone made every invalidation there a silent no-op. #1163
  const consulteeId = consulteeIdOverride || params?.consulteeId;

  // Refresh every surface that renders this booking (events across all org
  // scopes via prefix match, plus the home pending-payments widget) without
  // the full-page reload that used to nuke the react-query cache and SPA
  // state after cancel/reschedule.
  const invalidateBookingData = () => {
    // The detail hub renders this booking on every dashboard — always
    // refresh it, whatever route the action came from. #1163
    if (appointmentId) {
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
    }
    // Outside the consultee route the id may be absent; an undefined key
    // segment would silently match nothing — bail instead.
    if (!consulteeId) return;
    void queryClient.invalidateQueries({
      queryKey: ["consultee-events", consulteeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["pending-payments", consulteeId],
    });
  };

  const [isLoading, setIsLoading] = useState(false);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [showConfirmReschedule, setShowConfirmReschedule] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  const getJoinableOccurrence = (): AppointmentOccurrence | null =>
    getJoinableOccurrenceShared(rawOccurrences ?? [], {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
    });

  const handleRescheduleClick = (isMultiSession: boolean) => {
    if (isMultiSession) {
      setShowRescheduleDialog(true);
    } else {
      setShowConfirmReschedule(true);
    }
  };

  /** Resolves true only when the release actually landed — the reschedule page
   *  navigates away on that, and must stay put (with the selection) on a
   *  failure the user can retry. */
  const handleReschedule = async (
    slotIds?: string[],
    proposedSlots?: { startsAt: string; endsAt: string }[],
    // #1065 — only meaningful alongside an absent proposedSlots: how to place
    // the replacement when the consultee names no time.
    preference?: SlotPreference,
    /** The zone the picker showed, for naming taken times back. */
    displayZone?: string,
    /** Replays the first answer when the same submission is sent again. */
    idempotencyKey?: string,
  ): Promise<boolean> => {
    if (!appointmentId) {
      toast({
        title: "Couldn't open this booking",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return false;
    }

    setIsLoading(true);
    setShowRescheduleDialog(false);

    try {
      const url =
        type === "Subscription"
          ? `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`
          : `/api/appointments/${appointmentId}/reschedule`;

      const payload: Record<string, unknown> = {};
      if (slotIds && slotIds.length > 0) payload.slotIds = slotIds;
      if (proposedSlots?.length) payload.proposedSlots = proposedSlots;
      if (preference?.preferredTimeOfDay)
        payload.preferredTimeOfDay = preference.preferredTimeOfDay;
      if (preference?.preferredDays)
        payload.preferredDays = preference.preferredDays;

      const response = await fetchWithIdentity(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
      });

      const data = (await requireJsonResponse(
        response,
        "Failed to request reschedule",
      )) as {
        sessionsAffected?: number;
        slotsAffected?: number;
        outcome?: RescheduleProposeCode;
        message?: string;
      };

      // #448 — show the SESSION count, not the slot count: a 1-hour session is
      // 2 × 30-min slots, so the old slotsAffected label read "2 sessions" for a
      // single session. sessionsAffected is the distinct-appointment count.
      const sessionsAffected =
        data.sessionsAffected ?? data.slotsAffected ?? slotIds?.length ?? 1;

      toast(
        rescheduleOutcomeToast({
          code: data.outcome,
          message: data.message,
          sessionsAffected,
        }),
      );

      invalidateBookingData();
      return true;
    } catch (error) {
      reportActionFailure(error, "appointment.reschedule");
      if (!isExpectedRefusal(error)) {
        console.error("Error requesting reschedule:", error);
      }
      const code = error instanceof ApiResponseError ? error.code : undefined;
      if (error instanceof ApiResponseError && code === "TIMES_TAKEN") {
        toast(
          rescheduleTimesTaken(
            takenStartsFrom(takenSlotStartsOf(error.body)),
            displayZone,
          ),
        );
        return false;
      }
      // #1863 — RESCHEDULE_ALREADY_OPEN is the one refusal here that is not a
      // dead end: the request they just made DID land, the first click won, and
      // the proposal is sitting on the appointment detail page waiting for an
      // answer. Toasting a bare "already open" left the user with no way to
      // reach it from the reschedule page they were standing on.
      const alreadyOpen = code === "RESCHEDULE_ALREADY_OPEN";
      const refused = codedRefusalToast(
        code,
        error instanceof Error ? error.message : "Failed to request reschedule",
        "Couldn't request a reschedule",
      );
      toast({
        title: alreadyOpen ? "You already have a reschedule open" : refused.title,
        description: alreadyOpen
          ? "Your first request went through — open it to withdraw it or see the new times."
          : refused.description,
        // NOT destructive when one is already open: nothing failed. Their first
        // click is sitting there waiting for an answer, and a red toast saying
        // "couldn't" is the wrong story about their own booking.
        ...(alreadyOpen ? {} : { variant: "destructive" as const }),
        // The proposal card is rendered by the appointment detail client, so
        // that is where "open it" goes — and only where the id is known, since
        // the org detail route resolves it differently and has no such card.
        ...(alreadyOpen && appointmentId && consulteeId
          ? {
              action: (
                <ToastAction
                  altText="Open this booking to see the open reschedule request"
                  onClick={() =>
                    router.push(
                      `/dashboard/consultee/${consulteeId}/appointments/${appointmentId}`,
                    )
                  }
                >
                  View request
                </ToastAction>
              ),
            }
          : {}),
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelClick = () => {
    if (!appointmentId) {
      toast({
        title: "Couldn't open this booking",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }
    setShowCancelDialog(true);
  };

  /** Resolves false when the dialog must stay open on a re-quoted refund. */
  const handleCancelConfirm = async (
    quote?: ShownCancelQuote,
  ): Promise<boolean> => {
    setIsLoading(true);
    try {
      const response = await fetchWithIdentity(
        `/api/appointments/${appointmentId}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(shownQuoteBody(quote)),
        },
      );
      const data = (await requireJsonResponse(
        response,
        "Failed to cancel appointment",
      )) as { refund?: CancelRefund };
      // The route reports what happened to the money on `refund`. Discarding
      // it meant a cancellation that refunded nothing — or failed to refund —
      // looked exactly like one that paid out in full.
      toast({
        title: "Appointment cancelled",
        description: [
          `Your ${type.toLowerCase()} "${title}" has been cancelled.`,
          describeRefund(data.refund ?? null, quote?.freeBooking),
        ]
          .filter(Boolean)
          .join(" "),
      });
      setShowCancelDialog(false);
      invalidateBookingData();
      return true;
    } catch (error) {
      // The refund moved since the dialog quoted it: show the new figure and
      // ask again, with nothing committed.
      const requote =
        error instanceof ApiResponseError && error.status === 409
          ? readRefundQuoteChanged(error.body)
          : null;
      // A click made on an unpaid screen: the payment has since landed, so the
      // booking reopens on its paid quote instead of re-asking in place.
      if (requote && paymentLandedUnderClick(quote)) {
        toast({
          title: "Your payment just went through",
          description: "Review the refund before you cancel.",
        });
        setShowCancelDialog(false);
        invalidateBookingData();
        return true;
      }
      if (requote && appointmentId) {
        const currency = applyRefundRequote(
          queryClient,
          cancelPreviewUrl(appointmentId),
          requote,
        );
        toast(refundChangedToast(requote, currency));
        return false;
      }
      // A refusal (the session froze, another refund must finish first) is
      // the server's own sentence; the dialog stays open on a fresh quote.
      const refusal =
        error instanceof ApiResponseError && error.status === 409
          ? cancelRefusalFrom(error.body)
          : null;
      if (refusal) {
        toast({
          title: "This booking can't be cancelled right now",
          description: refusal.message,
          variant: "destructive",
        });
        if (appointmentId) {
          void queryClient.invalidateQueries({
            queryKey: cancelPreviewQueryKey(cancelPreviewUrl(appointmentId)),
          });
        }
        return false;
      }
      // 409 = the CAS transition guard matched zero rows: the booking already
      // changed state (double-cancel, consultant approved a stale tab, …).
      // The list refresh IS the answer — not an error.
      if (error instanceof ApiResponseError && error.status === 409) {
        if (!cancelAlreadySettled(error.code)) {
          toast({
            title: "This booking can't be cancelled right now",
            description: actionFailureMessage(
              error,
              "Failed to cancel appointment",
            ),
            variant: "destructive",
          });
          return false;
        }
        toast({
          title: "Booking already updated",
          description:
            "This booking changed state in the meantime — refreshing.",
        });
        setShowCancelDialog(false);
        invalidateBookingData();
        return true;
      }
      reportActionFailure(error, "appointment.cancel");
      console.error("Error cancelling appointment:", error);
      toast({
        title: "Couldn't cancel appointment",
        description: actionFailureMessage(
          error,
          "Failed to cancel appointment",
        ),
        variant: "destructive",
      });
      return true;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    joinableSlot: getJoinableOccurrence(),
    showRescheduleDialog,
    setShowRescheduleDialog,
    showConfirmReschedule,
    setShowConfirmReschedule,
    showReportDialog,
    setShowReportDialog,
    showCancelDialog,
    setShowCancelDialog,
    handleRescheduleClick,
    handleReschedule,
    handleCancelClick,
    handleCancelConfirm,
  };
}
