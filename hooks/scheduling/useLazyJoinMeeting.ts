"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportClientFailure } from "@/lib/errors/classification/client-failure";
import { failureToast } from "@/components/ui/failure-toast";
// #248: type-only imports are erased at compile time, so referencing
// lib/meeting's types here does NOT pull the Stream SDK into the bundle.
// MeetingAppointment/MeetingSlot are structural subsets that TAppointment
// and its slots satisfy, so callers pass their richer types directly.
import type { MeetingAppointment, MeetingSlot } from "@/lib/meeting";
import {
  describeVideoClientWait,
  waitForGlobalVideoClient,
} from "@/lib/stream/disconnect";

/**
 * Join-meeting handler that keeps the Stream video SDK off the tab
 * bundles (#248): the already-connected video client singleton is read at
 * click time (same instance <StreamVideo> uses) instead of via
 * useStreamVideoClient, and lib/meeting — which statically imports the
 * SDK — is dynamic-imported on demand.
 *
 * Previously HomeTab had this pattern privately while AppointmentsTab,
 * TrialsTab, and the planner each statically imported the SDK, dragging
 * it into every consultant page. One hook, one bundle boundary.
 *
 * Returns true when navigation to the meeting was initiated — callers
 * tracking per-row "joining" state can reset it on false.
 */
export function useLazyJoinMeeting() {
  const router = useRouter();
  const { toast } = useToast();

  return useCallback(
    async (
      appointment: MeetingAppointment,
      joinableSlot?: MeetingSlot,
    ): Promise<boolean> => {
      // The video connect is deferred to requestIdleCallback, so a fast
      // Join click can land before the client exists — briefly wait for
      // it instead of immediately erroring.
      const waitStartedAt = Date.now();
      const client = await waitForGlobalVideoClient();
      if (!client) {
        // Reported so this stays distinguishable from a chunk failure in
        // Sentry as well as in the toast. Expected: the user is told to try
        // again and the retry normally works — the extras are what say
        // whether that is still true.
        reportSentryMessage("Video client not ready at Join", {
          subsystem: "client",
          op: "join-meeting",
          expected: true,
          extra: describeVideoClientWait(Date.now() - waitStartedAt),
        });
        toast({
          title: "Connecting…",
          description: "Setting up your meeting client. Please try Join again.",
          // The other two join surfaces show this state as a warning; without
          // it the same condition looks different depending on where you
          // clicked Join.
          variant: "warning",
        });
        return false;
      }

      const relevantSlot = joinableSlot ?? appointment.slotsOfAppointment?.[0];
      if (!relevantSlot) {
        toast({
          title: "Error",
          description: "Slot information missing for this appointment.",
          variant: "destructive",
        });
        return false;
      }

      try {
        const { getOrCreateAppointmentMeeting } = await import("@/lib/meeting");
        const meetingId = await getOrCreateAppointmentMeeting(
          client,
          appointment,
          relevantSlot,
        );
        router.push(`/meetings/${meetingId}`);
        toast({
          title: "Joining meeting",
          description: "You will now be redirected to the meeting room.",
        });
        return true;
      } catch (error) {
        console.error("Error joining meeting:", error);
        toast(
          failureToast(
            reportClientFailure(error, {
              subsystem: "client",
              op: "join-meeting",
              title: "Error joining meeting",
              extra: {
                appointmentId: appointment.id,
                slotId: relevantSlot.id,
              },
            }),
          ),
        );
        return false;
      }
    },
    [router, toast],
  );
}
