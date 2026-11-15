"use client";

import { useState } from "react";
import { trialCancelRequest } from "@/schemas/trials";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/hooks/use-toast";
import { useZonedFormat } from "@/lib/time/zoned-format";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";
import {
  ApiResponseError,
  actionFailureMessage,
  requireJsonResponse,
} from "@/lib/fetch-helpers";
import { useQueryClient } from "@tanstack/react-query";
import type { OccurrenceLike } from "@/lib/appointments/view-model";
import type { SlotPreference } from "@/components/scheduling/time-picker-policy";
import {
  applyRefundRequote,
  paymentLandedUnderClick,
  cancelPreviewQueryKey,
  cancelAlreadySettled,
  cancelPreviewUrl,
  cancelRefusalFrom,
  readRefundQuoteChanged,
  shownQuoteBody,
  type ShownCancelQuote,
} from "@/lib/appointments/cancel-requote";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import {
  rescheduleTimesTaken,
  takenStartsFrom,
} from "@/lib/scheduling/allocationMessages";
import { takenSlotStartsOf } from "@/lib/scheduling/allocationService";

interface UseConsultantEventActionsOptions {
  consultantId: string;
  appointmentId?: string;
  /** Kept for call-site parity with consultee actions / reschedule modal. */
  rawOccurrences: OccurrenceLike[];
  title: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
}

const RetimeAnswerSchema = z.object({
  attendeesWithClash: z.number(),
  retimeBy: z.string(),
});

/** Shape of `/api/appointments/[id]/cancel`'s `refund` field (1:1 bookings). */
interface CancelRefundResult {
  status:
    "REFUNDED" | "PENDING" | "FAILED" | "NOTHING_REFUNDABLE" | "POLICY_ZERO";
}

/** Shape of the same route's `eventRefund` field (class/webinar). */
interface CancelEventRefundSummary {
  failures: { paymentId: string; error: string }[];
  /** Seats left for the retry sweep after the inline bite. */
  deferred?: number;
}

/**
 * #1527 review — the old copy always promised "everyone who paid gets a
 * full refund", even though the route's own `refund`/`eventRefund` fields
 * (added for exactly this) can say PENDING, FAILED or that nothing was
 * refundable. Read the response instead of assuming the happy path.
 */
function cancelRefundSentence(body: unknown): string {
  const { refund, eventRefund } = (body ?? {}) as {
    refund?: CancelRefundResult | null;
    eventRefund?: CancelEventRefundSummary | null;
  };
  if (eventRefund) {
    if (eventRefund.failures.length > 0) {
      return "Most refunds have gone out; a few need a manual look, and support has been notified.";
    }
    return (eventRefund.deferred ?? 0) > 0
      ? "Because you cancelled, everyone who paid is being refunded; the remaining refunds follow shortly."
      : "Because you cancelled, everyone who paid has been refunded.";
  }
  switch (refund?.status) {
    case "REFUNDED":
      return "Because you cancelled, whoever paid has been refunded in full.";
    case "PENDING":
      return "Because you cancelled, the refund is being processed.";
    case "FAILED":
      return "Because you cancelled, a refund is owed but couldn't be completed automatically — support has been notified.";
    case "NOTHING_REFUNDABLE":
    case "POLICY_ZERO":
      return "No further refund was owed on this booking.";
    default:
      return "";
  }
}

/**
 * Cancel / reschedule mutations for the consultant appointments surface.
 * Mirrors consultee `useEventActions` against the same APIs, with consultant
 * query-cache invalidation.
 */
export function useConsultantEventActions({
  consultantId,
  appointmentId,
  title,
  type,
}: UseConsultantEventActionsOptions) {
  const { toast } = useToast();
  const formatZoned = useZonedFormat();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);

  const invalidateBookingData = () => {
    void queryClient.invalidateQueries({
      queryKey: ["consultant-appointments", consultantId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["consultant-dashboard", consultantId],
    });
    if (appointmentId) {
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["appointment-documents", appointmentId],
      });
    }
  };

  /**
   * Release sessions, optionally naming the times to replace them with.
   *
   * A consultant proposal never auto-confirms — publishing availability is
   * standing consent to be booked inside it, but merely being free is not
   * consent to be moved — so these times are always an offer to the consultee.
   * Resolves true only when the release landed, which is what lets the
   * reschedule page navigate on success and stay put on failure.
   */
  const handleReschedule = async (
    slotIds?: string[],
    proposedSlots?: { startsAt: string; endsAt: string }[],
    // #1065 — only meaningful alongside an absent proposedSlots: how to place
    // the replacement when no time is named.
    preference?: SlotPreference,
    /** The zone the picker showed, for naming taken times back. */
    displayZone?: string,
    /** Replays the first answer when the same submission is sent again. */
    idempotencyKey?: string,
  ): Promise<boolean> => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return false;
    }

    setIsLoading(true);
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
      )) as { sessionsAffected?: number; slotsAffected?: number };

      const sessionsAffected =
        data.sessionsAffected ?? data.slotsAffected ?? slotIds?.length ?? 1;

      toast(
        proposedSlots?.length
          ? {
              title: "Times proposed",
              description: "The learner has been asked to accept the new time.",
            }
          : {
              title: "Ready to reschedule",
              description:
                sessionsAffected === 1
                  ? "Select a new time for this session."
                  : `Select new times for ${sessionsAffected} sessions.`,
            },
      );

      invalidateBookingData();
      return true;
    } catch (error) {
      if (error instanceof ApiResponseError && error.code === "TIMES_TAKEN") {
        toast(
          rescheduleTimesTaken(
            takenStartsFrom(takenSlotStartsOf(error.body)),
            displayZone,
          ),
        );
        return false;
      }
      // The same refusal the consultee page sees (FAMILIARISE_WEB-2Z): shown,
      // not captured.
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client" } },
        );
      }
      toast({
        title: "Error",
        description: userMessageFrom(error, "Failed to request reschedule"),
        variant: "destructive",
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Move a published webinar to `startsAt` in one step. Resolves true when it
   * moved; refusals (too soon, the host is busy then) are shown, not captured.
   */
  const handleRetime = async (startsAt: string): Promise<boolean> => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return false;
    }

    setIsLoading(true);
    try {
      const response = await fetchWithIdentity(
        `/api/appointments/${appointmentId}/retime`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startsAt }),
        },
      );
      const data = RetimeAnswerSchema.parse(
        await requireJsonResponse(response, "Couldn't move the webinar"),
      );
      toast({
        title: "Webinar moved",
        description:
          `"${title}" has a new date. Attendees were offered a full refund until ${formatZoned(data.retimeBy, "EEE, d MMM · h:mm a")}.` +
          (data.attendeesWithClash > 0
            ? ` ${data.attendeesWithClash} already have another session then.`
            : ""),
      });
      invalidateBookingData();
      return true;
    } catch (error) {
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client" } },
        );
      }
      toast({
        title: "Couldn't move the webinar",
        description: userMessageFrom(error, "Couldn't move the webinar"),
        variant: "destructive",
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  /** Resolves false when the dialog must stay open on a re-quoted refund. */
  const handleCancelConfirm = async (
    quote?: ShownCancelQuote,
  ): Promise<boolean> => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return true;
    }

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
      // Typed read: an edge 504 page must not surface as a JSON SyntaxError.
      let body: unknown;
      try {
        body = await requireJsonResponse(
          response,
          "Failed to cancel appointment",
        );
      } catch (error) {
        // The refund moved since the dialog quoted it: show the new figure
        // and ask again, with nothing committed.
        const requote =
          error instanceof ApiResponseError && error.status === 409
            ? readRefundQuoteChanged(error.body)
            : null;
        if (requote && paymentLandedUnderClick(quote)) {
          toast({
            title: "The payment just went through",
            description: "Review the refund before you cancel.",
          });
          invalidateBookingData();
          return true;
        }
        if (requote) {
          applyRefundRequote(
            queryClient,
            cancelPreviewUrl(appointmentId),
            requote,
          );
          toast({
            title: "The refund has changed",
            description:
              "Check the new amount in the dialog and confirm again.",
          });
          return false;
        }
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
          void queryClient.invalidateQueries({
            queryKey: cancelPreviewQueryKey(cancelPreviewUrl(appointmentId)),
          });
          return false;
        }
        if (
          error instanceof ApiResponseError &&
          error.status === 409 &&
          !cancelAlreadySettled(error.code)
        ) {
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
        if (error instanceof ApiResponseError && error.status === 409) {
          toast({
            title: "Booking already updated",
            description:
              "This booking changed state in the meantime — refreshing.",
          });
          invalidateBookingData();
          return true;
        }
        throw error;
      }

      // A cancellation the expert makes is quoted at the 100% tier, whatever
      // the policy's notice tiers say (consultantInitiatedPct is 100, #1527) —
      // but the actual refund can still be pending/failed, so the toast reads
      // the route's own refund result instead of assuming success.
      const refundSentence = cancelRefundSentence(body);
      toast({
        title: "Appointment cancelled",
        description:
          `${type} "${title}" has been cancelled.` +
          (refundSentence ? ` ${refundSentence}` : ""),
      });
      invalidateBookingData();
      return true;
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
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

  /**
   * Cancel a trial through its own door (`DELETE /api/trials/[id]`) with the
   * refund the dialog showed. The expert's cancel refunds the learner in full
   * and records a strike; a changed quote re-asks with nothing committed.
   */
  const handleTrialCancel = async (
    trialId: string,
    quote?: ShownCancelQuote,
  ): Promise<boolean> => {
    const previewUrl = `/api/trials/${trialId}/cancel/preview`;
    setIsLoading(true);
    try {
      const { url, body } = trialCancelRequest(trialId, quote);
      const response = await fetchWithIdentity(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        await requireJsonResponse(response, "Failed to cancel trial");
      } catch (error) {
        if (error instanceof ApiResponseError && error.status === 409) {
          void queryClient.invalidateQueries({
            queryKey: cancelPreviewQueryKey(previewUrl),
          });
          toast({
            title: "This trial can't be cancelled right now",
            description: actionFailureMessage(error, "Failed to cancel trial"),
            variant: "destructive",
          });
          return false;
        }
        throw error;
      }
      toast({
        title: "Trial cancelled",
        description: `"${title}" has been cancelled. The learner is refunded in full if they paid.`,
      });
      invalidateBookingData();
      return true;
    } catch (error) {
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client" } },
        );
      }
      toast({
        title: "Error",
        description: actionFailureMessage(error, "Failed to cancel trial"),
        variant: "destructive",
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    handleReschedule,
    handleRetime,
    handleCancelConfirm,
    handleTrialCancel,
  };
}
