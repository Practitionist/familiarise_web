"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import type { SlotOfAppointment } from "@prisma/client";

interface UseConsultantEventActionsOptions {
  consultantId: string;
  appointmentId?: string;
  rawSlots: Array<Pick<SlotOfAppointment, "id" | "startsAt" | "endsAt"> & {
    isTentative?: boolean;
    appointmentId?: string | null;
  }>;
  title: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
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

  const handleReschedule = async (slotIds?: string[]) => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const url =
        type === "Subscription"
          ? `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`
          : `/api/appointments/${appointmentId}/reschedule`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          slotIds && slotIds.length > 0
            ? JSON.stringify({ slotIds })
            : undefined,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to request reschedule");
      }

      const sessionsAffected =
        data.sessionsAffected ?? data.slotsAffected ?? slotIds?.length ?? 1;

      toast({
        title: "Ready to reschedule",
        description:
          sessionsAffected === 1
            ? "Select a new time for this session."
            : `Select new times for ${sessionsAffected} sessions.`,
      });

      invalidateBookingData();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to request reschedule",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelConfirm = async () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/cancel`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          toast({
            title: "Booking already updated",
            description:
              "This booking changed state in the meantime — refreshing.",
          });
          invalidateBookingData();
          return;
        }
        throw new Error(data.error || "Failed to cancel appointment");
      }

      const refundNote =
        type === "Consultation" || type === "Subscription"
          ? " Any eligible refund follows your cancellation policy."
          : "";

      toast({
        title: "Appointment cancelled",
        description: `${type} "${title}" has been cancelled.${refundNote}`,
      });
      invalidateBookingData();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to cancel appointment",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    handleReschedule,
    handleCancelConfirm,
  };
}
