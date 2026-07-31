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
import { SlotPicker } from "@/components/scheduling/SlotPicker";
import { manageTimingsPolicy } from "@/components/scheduling/slot-picker-policy";
import type { UnscheduledAppointment } from "../utils/unscheduledAppointments";
import { getClassPlanDefaults, type ClassPlanType } from "@/utils/classPlans";

/**
 * The consultant setting the times of their own event instance — the fourth
 * caller of the shared slot-picker surface, and the one that already handled
 * all four offering types and clamped to the scheduling period, so it is what
 * `SlotPicker` was generalised FROM. It stays a dialog (nothing here is
 * per-appointment enough to deserve a URL) and everything below the header is
 * now the shared component under the MANAGE_TIMINGS policy.
 */

interface EventDetails {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  sessionsPerWeek?: number;
  durationInMonths: number;
  durationInHours: number;
  sessionDurationInHours?: number;
  totalSessions?: number;
  title: string;
  planType?: ClassPlanType;
}

/** Only the recurring types carry a scheduling period to clamp to. */
function getSchedulingPeriod(appointment: UnscheduledAppointment): {
  start?: Date;
  end?: Date;
} {
  const event =
    appointment.appointmentType === "SUBSCRIPTION"
      ? appointment.subscription
      : appointment.appointmentType === "CLASS"
        ? appointment.class
        : null;
  return {
    start: event?.schedulingPeriodStartsAt
      ? new Date(event.schedulingPeriodStartsAt)
      : undefined,
    end: event?.schedulingPeriodEndsAt
      ? new Date(event.schedulingPeriodEndsAt)
      : undefined,
  };
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
          sessionsPerWeek: 1,
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
          sessionsPerWeek:
            appointment.subscription?.subscriptionPlan?.sessionsPerWeek || 1,
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
          sessionsPerWeek: 1,
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
          sessionsPerWeek: defaults.classesPerWeek,
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
          sessionsPerWeek: 1,
          durationInMonths: 1,
          durationInHours: 1,
          title: "Event",
        };
    }
  };

  const eventDetails = getEventDetails(appointment);
  const schedulingPeriod = getSchedulingPeriod(appointment);

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
        const baseText = `Schedule ${eventDetails.sessionsPerWeek} session${eventDetails.sessionsPerWeek !== 1 ? "s" : ""} per week for ${eventDetails.durationInMonths} month${eventDetails.durationInMonths !== 1 ? "s" : ""}. Each session is ${eventDetails.sessionDurationInHours || 1} hour${(eventDetails.sessionDurationInHours || 1) > 1 ? "s" : ""}.`;
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
        const sessionsPerWeek = eventDetails.sessionsPerWeek || 1;
        const classBaseText = `Schedule ${sessionsPerWeek} session${sessionsPerWeek !== 1 ? "s" : ""} per week. Each session is ${durationText}.`;
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
      <DialogContent className="max-w-7xl max-h-[90dvh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {appointment.appointmentType === "CLASS"
              ? "Manage Class Timings"
              : `Manage ${eventDetails.title} Timings`}
          </DialogTitle>
          <DialogDescription>{getDescriptionText()}</DialogDescription>
          {appointment.appointmentType === "CLASS" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                Plan: {eventDetails.planType || "Custom"}
              </Badge>
              <span>
                {eventDetails.sessionsPerWeek} meetings/week ·{" "}
                {eventDetails.durationInMonths} month
                {eventDetails.durationInMonths !== 1 ? "s" : ""} ·{" "}
                {eventDetails.durationInHours || 1}h/session
              </span>
            </div>
          )}
        </DialogHeader>

        {/* Guidance prompt for class rules */}
        {appointment.appointmentType === "CLASS" && (
          <div className="mb-2 shrink-0 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            Tip: Each class is{" "}
            {Math.ceil((eventDetails.durationInHours || 1) / 0.5)} consecutive
            30‑min slots. Complete an in‑progress class before starting another.
            Max {eventDetails.sessionsPerWeek || 2} classes per day; weekly
            limit applies.
          </div>
        )}

        <SlotPicker
          className="min-h-0 flex-1"
          policy={manageTimingsPolicy({ onSubmit: onClose })}
          onCancel={onClose}
          subject={{
            consultantProfileId: consultantId,
            eventType: eventDetails.eventType,
            eventId: eventDetails.eventId,
            durationInMonths: eventDetails.durationInMonths,
            sessionsPerWeek: eventDetails.sessionsPerWeek,
            // One duration field, two meanings: a consultation or webinar has
            // a single session of this length, a subscription or class has
            // many of it.
            durationInHours:
              eventDetails.eventType === "webinar" ||
              eventDetails.eventType === "consultation"
                ? eventDetails.durationInHours
                : undefined,
            sessionDurationInHours:
              eventDetails.eventType === "subscription" ||
              eventDetails.eventType === "class"
                ? eventDetails.durationInHours
                : undefined,
            totalSessions: eventDetails.totalSessions,
            // Guard rails: keep selection inside the plan's scheduling period.
            allowedStart: schedulingPeriod.start,
            allowedEnd: schedulingPeriod.end,
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
