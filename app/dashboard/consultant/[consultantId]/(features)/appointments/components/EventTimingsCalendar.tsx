"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useParams } from "next/navigation";
import { SafeUnifiedCalendar } from "../../shared/components/SafeUnifiedCalendar";
import { TAppointment } from "@/types/appointment";

interface EventTimingsCalendarProps {
  isOpen: boolean;
  onClose: () => void;
  appointment: TAppointment;
}

export function EventTimingsCalendar({
  isOpen,
  onClose,
  appointment,
}: EventTimingsCalendarProps) {
  const params = useParams();
  const { toast } = useToast();

  const consultantId = params.consultantId?.toString() || "";

  // Extract event details from appointment
  const detectClassPlan = (plan: any) => {
    const title: string = (plan?.title || "").toString().toLowerCase();
    if (title.includes("comprehens")) return "Comprehensive" as const;
    if (title.includes("extended")) return "Extended" as const;
    if (title.includes("basic")) return "Basic" as const;
    return "Custom" as const;
  };

  const deriveClassNumbers = (plan: any) => {
    const type = detectClassPlan(plan);
    const classesPerWeekFromPlan = plan?.classesPerWeek ?? plan?.callsPerWeek;
    const durationInMonthsFromPlan = plan?.durationInMonths;
    const sessionDurationInHours = plan?.sessionDurationInHours ?? 1;

    let classesPerWeek = classesPerWeekFromPlan;
    let durationInMonths = durationInMonthsFromPlan;

    if (
      classesPerWeek === undefined ||
      classesPerWeek === null ||
      Number.isNaN(Number(classesPerWeek))
    ) {
      classesPerWeek =
        type === "Basic"
          ? 2
          : type === "Extended"
            ? 3
            : type === "Comprehensive"
              ? 4
              : 2;
    }
    if (
      durationInMonths === undefined ||
      durationInMonths === null ||
      Number.isNaN(Number(durationInMonths))
    ) {
      durationInMonths =
        type === "Basic"
          ? 1
          : type === "Extended"
            ? 2
            : type === "Comprehensive"
              ? 4
              : 1;
    }

    return { type, classesPerWeek, durationInMonths, sessionDurationInHours };
  };
  const getEventDetails = (appointment: TAppointment) => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return {
          eventType: "consultation" as const,
          eventId: appointment.consultation?.id || "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours:
            appointment.consultation?.consultationPlan?.durationInHours || 1,
          title:
            appointment.consultation?.consultationPlan?.title || "Consultation",
        };
      case "SUBSCRIPTION":
        return {
          eventType: "subscription" as const,
          eventId: appointment.subscription?.id || "",
          callsPerWeek:
            appointment.subscription?.subscriptionPlan?.callsPerWeek || 1,
          durationInMonths:
            appointment.subscription?.subscriptionPlan?.durationInMonths || 1,
          durationInHours:
            appointment.subscription?.subscriptionPlan
              ?.sessionDurationInHours || 1,
          title:
            appointment.subscription?.subscriptionPlan?.title || "Subscription",
        };
      case "WEBINAR":
        return {
          eventType: "webinar" as const,
          eventId: appointment.webinar?.id || "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours:
            appointment.webinar?.webinarPlan?.durationInHours || 1,
          title: appointment.webinar?.webinarPlan?.title || "Webinar",
        };
      case "CLASS": {
        const plan = (appointment.class as any)?.classPlan || {};
        const derived = deriveClassNumbers(plan);
        return {
          eventType: "class" as const,
          eventId: appointment.class?.id || "",
          callsPerWeek: derived.classesPerWeek,
          durationInMonths: derived.durationInMonths,
          durationInHours: derived.sessionDurationInHours,
          title: plan?.title || "Class",
          // extra for UI only
          planType: derived.type,
        } as any;
      }
      default:
        return {
          eventType: "consultation" as const,
          eventId: "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours: 1,
          title: "Event",
        };
    }
  };

  const eventDetails = getEventDetails(appointment);

  // Log subscription start/end by calling server validation (read-only) when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    if (appointment.appointmentType !== "SUBSCRIPTION") return;
    if (!eventDetails.eventId) return;

    (async () => {
      try {
        const res = await fetch(
          `/api/events/subscriptions/${eventDetails.eventId}/validate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slots: [] }),
          }
        );
        const data = await res.json();
        const sv = data?.data?.subscriptionValidation;
        // Console log to verify subscription period used by server validation
        console.log("[Subscription Validation Period]", {
          subscriptionId: eventDetails.eventId,
          startDate: sv?.subscriptionPeriod?.start,
          endDate: sv?.subscriptionPeriod?.end,
          maxTotalCalls: sv?.maxTotalCalls,
        });
      } catch (error) {
        // silently ignore
      }
    })();
  }, [isOpen, appointment, eventDetails.eventId]);

  // Log class start/end window for debugging when dialog opens
  useEffect(() => {
    if (!isOpen) return;
    if (appointment.appointmentType !== "CLASS") return;

    const start = (appointment.class as any)?.startDate
      ? new Date((appointment.class as any).startDate)
      : undefined;
    const end = (appointment.class as any)?.endDate
      ? new Date((appointment.class as any).endDate)
      : undefined;

    // Safe console output for verification
    // eslint-disable-next-line no-console
    console.log("[Class Scheduling Window]", {
      classId: eventDetails.eventId,
      planType: (eventDetails as any)?.planType || "Unknown",
      callsPerWeek: eventDetails.callsPerWeek,
      durationInMonths: eventDetails.durationInMonths,
      sessionDurationInHours: eventDetails.durationInHours,
      startDate: start?.toISOString() ?? null,
      endDate: end?.toISOString() ?? null,
    });
  }, [
    isOpen,
    appointment,
    eventDetails.eventId,
    eventDetails.callsPerWeek,
    eventDetails.durationInMonths,
    eventDetails.durationInHours,
  ]);

  const handleAllocationComplete = () => {
    toast({
      title: "Success",
      description: "Timings allocated successfully",
    });
    onClose();
  };

  const getDescriptionText = () => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return "Select time slots for your consultation session.";
      case "SUBSCRIPTION":
        return `Schedule ${eventDetails.callsPerWeek} call${eventDetails.callsPerWeek !== 1 ? "s" : ""} per week for ${eventDetails.durationInMonths} month${eventDetails.durationInMonths !== 1 ? "s" : ""}.`;
      case "WEBINAR":
        return "Select consecutive time slots matching your webinar duration.";
      case "CLASS":
        return "Schedule class sessions by selecting appropriate time slots.";
      default:
        return "Select time slots for your event.";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl">
        <DialogHeader>
          <DialogTitle>
            {appointment.appointmentType === "CLASS"
              ? "Manage Class Timings"
              : `Manage ${eventDetails.title} Timings`}
          </DialogTitle>
          <DialogDescription>{getDescriptionText()}</DialogDescription>
          {appointment.appointmentType === "CLASS" && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                Plan: {(eventDetails as any).planType || "Custom"}
              </Badge>
              <span>
                {(eventDetails as any).callsPerWeek} classes/week ·{" "}
                {eventDetails.durationInMonths} month
                {eventDetails.durationInMonths !== 1 ? "s" : ""} ·{" "}
                {eventDetails.durationInHours || 1}h/session
              </span>
            </div>
          )}
        </DialogHeader>

        {/* Guidance prompt for class rules */}
        {appointment.appointmentType === "CLASS" && (
          <div className="mb-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            Tip: Each class is 2 consecutive 30‑min slots. Complete an
            in‑progress class before starting another. Max 2 classes per day;
            weekly limit applies.
          </div>
        )}

        <SafeUnifiedCalendar
          consultantId={consultantId}
          eventType={eventDetails.eventType}
          eventId={eventDetails.eventId}
          durationInMonths={eventDetails.durationInMonths}
          callsPerWeek={eventDetails.callsPerWeek}
          durationInHours={
            eventDetails.eventType === "webinar" ||
            eventDetails.eventType === "consultation"
              ? eventDetails.durationInHours
              : undefined
          }
          sessionDurationInHours={
            eventDetails.eventType === "subscription" ||
            eventDetails.eventType === "class"
              ? eventDetails.durationInHours
              : undefined
          }
          mode="allocate"
          onAllocationComplete={handleAllocationComplete}
          showAllocationButtons={true}
          className="min-h-[500px]"
          // UI guard rails: restrict selection window based on validation period
          allowedStart={
            appointment.appointmentType === "SUBSCRIPTION"
              ? appointment.subscription?.startDate
                ? new Date(appointment.subscription.startDate)
                : undefined
              : appointment.appointmentType === "CLASS"
                ? (appointment.class as any)?.startDate
                  ? new Date((appointment.class as any).startDate)
                  : undefined
                : undefined
          }
          allowedEnd={
            appointment.appointmentType === "SUBSCRIPTION"
              ? appointment.subscription?.endDate
                ? new Date(appointment.subscription.endDate)
                : undefined
              : appointment.appointmentType === "CLASS"
                ? (appointment.class as any)?.endDate
                  ? new Date((appointment.class as any).endDate)
                  : undefined
                : undefined
          }
        />

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
