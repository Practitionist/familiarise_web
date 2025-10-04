"use client";

import { Badge } from "@/components/ui/badge";
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
import { getClassPlanDefaults } from "@/utils/classPlans";

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
        const defaults = getClassPlanDefaults(plan);
        return {
          eventType: "class" as const,
          eventId: appointment.class?.id || "",
          callsPerWeek: defaults.classesPerWeek,
          durationInMonths: defaults.durationInMonths,
          durationInHours: defaults.sessionDurationInHours,
          title: plan?.title || "Class",
          // extra for UI only
          planType: defaults.type,
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

  // Removed debug validation logging - production code uses validation directly in calendar

  // Removed debug logging - production code validates dates server-side

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
        return "Select consecutive time slots for your consultation. All slots must be on the same day.";
      case "SUBSCRIPTION":
        return `Schedule ${eventDetails.callsPerWeek} call${eventDetails.callsPerWeek !== 1 ? "s" : ""} per week for ${eventDetails.durationInMonths} month${eventDetails.durationInMonths !== 1 ? "s" : ""}. Each call is ${eventDetails.sessionDurationInHours || 1} hour${(eventDetails.sessionDurationInHours || 1) > 1 ? "s" : ""}.`;
      case "WEBINAR":
        return "Select consecutive time slots for your webinar session.";
      case "CLASS":
        const sessionDuration = eventDetails.sessionDurationInHours || 1;
        const durationText = sessionDuration === 1 ? "1 hour" : `${sessionDuration} hours`;
        return `Schedule ${eventDetails.callsPerWeek || 1} session${(eventDetails.callsPerWeek || 1) !== 1 ? "s" : ""} per week. Each session is ${durationText}.`;
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
          onClose={onClose}
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
      </DialogContent>
    </Dialog>
  );
}
