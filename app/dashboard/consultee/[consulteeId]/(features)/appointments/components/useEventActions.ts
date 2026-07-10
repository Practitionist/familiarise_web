"use client";

import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useStreamVideoClient } from "@stream-io/video-react-sdk";
import { getOrCreateAppointmentMeeting } from "@/lib/meeting";
import type { TAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableSlot as getJoinableSlotShared,
} from "@/lib/appointments/slots";

interface UseEventActionsOptions {
  appointmentId?: string;
  appointment?: TAppointment;
  rawSlots: SlotOfAppointment[];
  title: string;
  consultant: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
}

export function useEventActions({
  appointmentId,
  appointment,
  rawSlots,
  title,
  consultant: _consultant,
  type,
}: UseEventActionsOptions) {
  const { toast } = useToast();
  const router = useRouter();
  const client = useStreamVideoClient();
  const queryClient = useQueryClient();
  const params = useParams<{ consulteeId: string }>();
  const consulteeId = params?.consulteeId;

  // Refresh every surface that renders this booking (events across all org
  // scopes via prefix match, plus the home pending-payments widget) without
  // the full-page reload that used to nuke the react-query cache and SPA
  // state after cancel/reschedule.
  const invalidateBookingData = () => {
    // Outside the consultee route the param is absent; an undefined key
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
  const [isJoining, setIsJoining] = useState(false);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [showConfirmReschedule, setShowConfirmReschedule] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  const getJoinableSlot = (): SlotOfAppointment | null =>
    getJoinableSlotShared(rawSlots ?? [], {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
    });

  const handleRescheduleClick = (isMultiSession: boolean) => {
    if (isMultiSession) {
      setShowRescheduleDialog(true);
    } else {
      setShowConfirmReschedule(true);
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
    setShowRescheduleDialog(false);

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

      // #448 — show the SESSION count, not the slot count: a 1-hour session is
      // 2 × 30-min slots, so the old slotsAffected label read "2 sessions" for a
      // single session. sessionsAffected is the distinct-appointment count.
      const sessionsAffected =
        data.sessionsAffected ?? data.slotsAffected ?? slotIds?.length ?? 1;

      toast({
        title: "Ready to reschedule",
        description:
          sessionsAffected === 1
            ? `Select a new time for your session.`
            : `Select new times for your ${sessionsAffected} sessions.`,
      });

      invalidateBookingData();
    } catch (error) {
      console.error("Error requesting reschedule:", error);
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

  const handleCancelClick = () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }
    setShowCancelDialog(true);
  };

  const handleCancelConfirm = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/cancel`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await response.json();
      if (!response.ok) {
        // 409 = the CAS transition guard matched zero rows: the booking
        // already changed state (double-cancel, consultant approved a
        // stale tab, …). The list refresh IS the answer — not an error.
        if (response.status === 409) {
          toast({
            title: "Booking already updated",
            description:
              "This booking changed state in the meantime — refreshing.",
          });
          setShowCancelDialog(false);
          invalidateBookingData();
          return;
        }
        throw new Error(data.error || "Failed to cancel appointment");
      }
      toast({
        title: "Appointment cancelled",
        description: `Your ${type.toLowerCase()} "${title}" has been cancelled successfully.`,
      });
      setShowCancelDialog(false);
      invalidateBookingData();
    } catch (error) {
      console.error("Error cancelling appointment:", error);
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

  const handleJoinSession = async (forceSlot?: SlotOfAppointment) => {
    const slotToUse = forceSlot || getJoinableSlot();

    if (!client) {
      toast({
        title: "Not signed in",
        description:
          "Video client not initialized. Please sign in to join the meeting.",
        variant: "destructive",
      });
      return;
    }

    if (!appointment || !slotToUse) {
      toast({
        title: "Unable to join",
        description: "Meeting information is not available.",
        variant: "destructive",
      });
      return;
    }

    setIsJoining(true);
    try {
      const meetingId = await getOrCreateAppointmentMeeting(
        client,
        appointment,
        slotToUse,
      );
      toast({
        title: "Joining meeting",
        description: "You will now be redirected to the meeting room.",
      });
      router.push(`/meetings/${meetingId}`);
    } catch (error) {
      console.error("Error joining meeting:", error);
      toast({
        title: "Error joining meeting",
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive",
      });
      setIsJoining(false);
    }
  };

  return {
    isLoading,
    isJoining,
    joinableSlot: getJoinableSlot(),
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
    handleJoinSession,
  };
}
