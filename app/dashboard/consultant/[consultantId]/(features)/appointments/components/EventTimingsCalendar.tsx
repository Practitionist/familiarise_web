"use client";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useParams } from "next/navigation";
import { SafeUnifiedCalendar } from "../../shared/components/SafeUnifiedCalendar";
import type { UnscheduledAppointment } from "../utils/unscheduledAppointments";
import { getClassPlanDefaults, type ClassPlanType } from "@/utils/classPlans";

interface EventDetails {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  callsPerWeek?: number;
  meetingsPerWeek?: number;
  durationInMonths: number;
  durationInHours: number;
  sessionDurationInHours?: number;
  totalSessions?: number;
  title: string;
  planType?: ClassPlanType;
}

interface EventTimingsCalendarProps {
  isOpen: boolean;
  onClose: () => void;
  appointment: UnscheduledAppointment;
  completedSessions?: number;
  groupTotalSessions?: number;
}

export function EventTimingsCalendar({
  isOpen,
  onClose,
  appointment,
  completedSessions,
  groupTotalSessions,
}: EventTimingsCalendarProps) {
  const params = useParams();

  const consultantId = params.consultantId?.toString() || "";
  const getEventDetails = (appointment: UnscheduledAppointment): EventDetails => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return {
          eventType: "consultation",
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
          eventType: "subscription",
          eventId: appointment.subscription?.id || "",
          callsPerWeek:
            appointment.subscription?.subscriptionPlan?.callsPerWeek || 1,
          durationInMonths:
            appointment.subscription?.subscriptionPlan?.durationInMonths || 1,
          durationInHours:
            appointment.subscription?.subscriptionPlan
              ?.sessionDurationInHours || 1,
          sessionDurationInHours:
            appointment.subscription?.subscriptionPlan
              ?.sessionDurationInHours || 1,
          totalSessions:
            appointment.subscription?.subscriptionPlan?.totalSessions ??
            undefined,
          title:
            appointment.subscription?.subscriptionPlan?.title || "Subscription",
        };
      case "WEBINAR":
        return {
          eventType: "webinar",
          eventId: appointment.webinar?.id || "",
          callsPerWeek: 1,
          durationInMonths: 1,
          durationInHours:
            appointment.webinar?.webinarPlan?.durationInHours || 1,
          title: appointment.webinar?.webinarPlan?.title || "Webinar",
        };
      case "CLASS": {
        const classPlan = appointment.class?.classPlan;
        const defaults = getClassPlanDefaults(classPlan ?? {});
        return {
          eventType: "class",
          eventId: appointment.class?.id || "",
          meetingsPerWeek: defaults.classesPerWeek,
          durationInMonths: defaults.durationInMonths,
          durationInHours:
            classPlan?.sessionDurationInHours ??
            defaults.sessionDurationInHours,
          totalSessions: classPlan?.totalSessions ?? undefined,
          title: classPlan?.title || "Class",
          planType: defaults.type,
        };
      }
      default:
        return {
          eventType: "consultation",
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
    onClose();
  };

  const appendProgressText = (
    baseText: string,
    completed?: number,
    total?: number,
  ): string => {
    if (completed && completed > 0 && total) {
      const remaining = total - completed;
      return `${baseText} ${completed} of ${total} sessions completed — select times for the remaining ${remaining}.`;
    }
    return baseText;
  };

  const getDescriptionText = () => {
    switch (appointment.appointmentType) {
      case "CONSULTATION":
        return "Select consecutive time slots for your consultation. All slots must be on the same day.";
      case "SUBSCRIPTION": {
        const baseText = `Schedule ${eventDetails.callsPerWeek} call${eventDetails.callsPerWeek !== 1 ? "s" : ""} per week for ${eventDetails.durationInMonths} month${eventDetails.durationInMonths !== 1 ? "s" : ""}. Each call is ${eventDetails.sessionDurationInHours || 1} hour${(eventDetails.sessionDurationInHours || 1) > 1 ? "s" : ""}.`;
        return appendProgressText(
          baseText,
          completedSessions,
          groupTotalSessions,
        );
      }
      case "WEBINAR":
        return "Select consecutive time slots for your webinar session.";
      case "CLASS": {
        const sessionDuration = eventDetails.durationInHours || 1;
        const durationText =
          sessionDuration === 1 ? "1 hour" : `${sessionDuration} hours`;
        const meetingsPerWeek = eventDetails.meetingsPerWeek || 1;
        const classBaseText = `Schedule ${meetingsPerWeek} meeting${meetingsPerWeek !== 1 ? "s" : ""} per week. Each session is ${durationText}.`;
        return appendProgressText(
          classBaseText,
          completedSessions,
          groupTotalSessions,
        );
      }
      default:
        return "Select time slots for your event.";
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      {/* FIX: Added max-h-[90vh] + overflow-y-auto to prevent footer cutoff on small screens */}
      <DialogContent className="max-w-7xl max-h-[90vh] overflow-y-auto">
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
                Plan: {eventDetails.planType || "Custom"}
              </Badge>
              <span>
                {eventDetails.meetingsPerWeek} meetings/week ·{" "}
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
            Tip: Each class is{" "}
            {Math.ceil((eventDetails.durationInHours || 1) / 0.5)} consecutive
            30‑min slots. Complete an in‑progress class before starting another.
            Max {eventDetails.meetingsPerWeek || 2} classes per day; weekly
            limit applies.
          </div>
        )}

        <SafeUnifiedCalendar
          consultantId={consultantId}
          eventType={eventDetails.eventType}
          eventId={eventDetails.eventId}
          durationInMonths={eventDetails.durationInMonths}
          callsPerWeek={
            // Map domain-specific terminology to generic calendar prop
            eventDetails.eventType === "class"
              ? eventDetails.meetingsPerWeek
              : eventDetails.callsPerWeek
          }
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
          totalSessions={eventDetails.totalSessions}
          mode="allocate"
          onAllocationComplete={handleAllocationComplete}
          onClose={onClose}
          showAllocationButtons={true}
          className="min-h-[500px]"
          // UI guard rails: restrict selection window based on validation period
          allowedStart={
            appointment.appointmentType === "SUBSCRIPTION"
              ? appointment.subscription?.schedulingPeriodStartsAt
                ? new Date(appointment.subscription.schedulingPeriodStartsAt)
                : undefined
              : appointment.appointmentType === "CLASS"
                ? appointment.class?.schedulingPeriodStartsAt
                  ? new Date(appointment.class.schedulingPeriodStartsAt)
                  : undefined
                : undefined
          }
          allowedEnd={
            appointment.appointmentType === "SUBSCRIPTION"
              ? appointment.subscription?.schedulingPeriodEndsAt
                ? new Date(appointment.subscription.schedulingPeriodEndsAt)
                : undefined
              : appointment.appointmentType === "CLASS"
                ? appointment.class?.schedulingPeriodEndsAt
                  ? new Date(appointment.class.schedulingPeriodEndsAt)
                  : undefined
                : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}
