import type { TimePickerSubject } from "@/components/scheduling/time-picker-policy";
import type { OccurrenceLike } from "@/lib/appointments/view-model";
import { getClassPlanDefaults, type ClassPlanType } from "@/utils/classPlans";
import { subscriptionPlanEnd } from "@/lib/booking/entitlement";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import { bookedSessionMinutes } from "@/lib/appointments/occurrences";

/**
 * Turns one of the four offering types into what the "manage timings" page
 * needs — ported from the dialog this route replaced (EventTimingsCalendar).
 *
 * Structural, not a Prisma payload type: the same fields come from a real
 * Appointment (already has some slots) or a bare Class/Webinar row (nothing
 * scheduled yet), see lib/data/manage-timings-target.ts for which. This only
 * ever reads what both can supply.
 */

export type ManageTimingsAppointmentType =
  "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";

export interface ManageTimingsAppointmentLike {
  appointmentType: ManageTimingsAppointmentType;
  /**
   * Every session of the program, past ones included — what the picker opens
   * focused on (#1073). A bare Class/Webinar row has none, which is itself
   * the answer there.
   */
  slots?: OccurrenceLike[];
  consultation?: {
    id?: string | null;
    consultationPlan?: {
      durationInHours?: number | null;
      title?: string | null;
    } | null;
  } | null;
  subscription?: {
    id?: string | null;
    schedulingPeriodStartsAt?: string | Date | null;
    schedulingTimezone?: string | null;
    planEndsAt?: string | Date | null;
    /** Terms frozen at purchase; null reads the plan. */
    sessionsPerWeek?: number | null;
    sessionMinutes?: number | null;
    sessionsTotal?: number | null;
    sessionsRefunded?: number;
    subscriptionPlan?: {
      sessionsPerWeek?: number | null;
      durationInMonths?: number | null;
      sessionDurationInHours?: number | null;
      totalSessions?: number | null;
      title?: string | null;
    } | null;
  } | null;
  webinar?: {
    id?: string | null;
    webinarPlan?: {
      durationInHours?: number | null;
      title?: string | null;
    } | null;
  } | null;
  class?: {
    id?: string | null;
    schedulingPeriodStartsAt?: string | Date | null;
    schedulingPeriodEndsAt?: string | Date | null;
    classPlan?: {
      title?: string | null;
      sessionsPerWeek?: number | null;
      durationInMonths?: number | null;
      sessionDurationInHours?: number | null;
      totalSessions?: number | null;
    } | null;
  } | null;
}

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

function getEventDetails(
  appointment: ManageTimingsAppointmentLike,
): EventDetails {
  switch (appointment.appointmentType) {
    case "CONSULTATION": {
      // The booked session's length; the plan's only with no session row.
      const booked = bookedSessionMinutes(appointment.slots ?? []);
      return {
        eventType: "consultation",
        eventId: appointment.consultation?.id || "",
        sessionsPerWeek: 1,
        durationInMonths: 1,
        durationInHours:
          booked === null
            ? appointment.consultation?.consultationPlan?.durationInHours || 1
            : booked / 60,
        title:
          appointment.consultation?.consultationPlan?.title || "Consultation",
      };
    }
    case "SUBSCRIPTION": {
      const sub = appointment.subscription;
      // The sold terms: frozen at purchase, else the plan's.
      const sessionHours = sub?.sessionMinutes
        ? sub.sessionMinutes / 60
        : sub?.subscriptionPlan?.sessionDurationInHours || 1;
      const sold =
        sub?.sessionsTotal ?? sub?.subscriptionPlan?.totalSessions ?? null;
      return {
        eventType: "subscription",
        eventId: sub?.id || "",
        sessionsPerWeek:
          sub?.sessionsPerWeek || sub?.subscriptionPlan?.sessionsPerWeek || 1,
        durationInMonths: sub?.subscriptionPlan?.durationInMonths || 1,
        durationInHours: sessionHours,
        sessionDurationInHours: sessionHours,
        totalSessions:
          sold === null ? undefined : sold - (sub?.sessionsRefunded ?? 0),
        title: sub?.subscriptionPlan?.title || "Subscription",
      };
    }
    case "WEBINAR":
      return {
        eventType: "webinar",
        eventId: appointment.webinar?.id || "",
        sessionsPerWeek: 1,
        durationInMonths: 1,
        durationInHours: appointment.webinar?.webinarPlan?.durationInHours || 1,
        title: appointment.webinar?.webinarPlan?.title || "Webinar",
      };
    case "CLASS": {
      const classPlan = appointment.class?.classPlan;
      // getClassPlanDefaults predates nullable Prisma fields — null and
      // "not provided" mean the same thing here, so normalize to undefined.
      const defaults = getClassPlanDefaults({
        title: classPlan?.title ?? undefined,
        sessionsPerWeek: classPlan?.sessionsPerWeek ?? undefined,
        durationInMonths: classPlan?.durationInMonths ?? undefined,
        sessionDurationInHours: classPlan?.sessionDurationInHours ?? undefined,
      });
      return {
        eventType: "class",
        eventId: appointment.class?.id || "",
        sessionsPerWeek: defaults.classesPerWeek,
        durationInMonths: defaults.durationInMonths,
        durationInHours:
          classPlan?.sessionDurationInHours ?? defaults.sessionDurationInHours,
        totalSessions: classPlan?.totalSessions ?? undefined,
        title: classPlan?.title || "Class",
        planType: defaults.type,
      };
    }
  }
}

/** Only the recurring types carry a scheduling period to clamp to; a
 * subscription's runs to its plan end. */
function getSchedulingPeriod(appointment: ManageTimingsAppointmentLike): {
  start?: Date;
  end?: Date;
} {
  if (appointment.appointmentType === "SUBSCRIPTION") {
    const sub = appointment.subscription;
    if (!sub?.schedulingPeriodStartsAt) return {};
    return {
      start: new Date(sub.schedulingPeriodStartsAt),
      end: subscriptionPlanEnd({
        planEndsAt: sub.planEndsAt ?? null,
        schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt,
        schedulingTimezone: resolveSchedulingTimezone(sub.schedulingTimezone),
        subscriptionPlan: {
          durationInMonths: sub.subscriptionPlan?.durationInMonths ?? 1,
        },
      }),
    };
  }
  const event =
    appointment.appointmentType === "CLASS" ? appointment.class : null;
  return {
    start: event?.schedulingPeriodStartsAt
      ? new Date(event.schedulingPeriodStartsAt)
      : undefined,
    end: event?.schedulingPeriodEndsAt
      ? new Date(event.schedulingPeriodEndsAt)
      : undefined,
  };
}

function appendProgressText(
  baseText: string,
  completed?: number,
  total?: number,
): string {
  if (completed && completed > 0 && total) {
    const remaining = total - completed;
    return `${baseText} ${completed} of ${total} sessions completed — select times for the remaining ${remaining}.`;
  }
  return baseText;
}

function getDescription(
  appointment: ManageTimingsAppointmentLike,
  eventDetails: EventDetails,
  completedSessions?: number,
  groupTotalSessions?: number,
): string {
  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return "Select consecutive time slots for your consultation.";
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
  }
}

export interface ManageTimingsClassInfo {
  planType: ClassPlanType;
  sessionsPerWeek: number;
  durationInMonths: number;
  durationInHours: number;
}

export interface ManageTimingsSubject {
  subject: TimePickerSubject;
  /** The offering's own title, for the page header — not "Manage timings"
   *  on every tab (#1064 pattern, matches the other three routes). */
  title: string;
  description: string;
  /** Only classes show the plan-type badge + scheduling tip. */
  classInfo?: ManageTimingsClassInfo;
}

export function buildManageTimingsSubject(
  consultantId: string,
  appointment: ManageTimingsAppointmentLike,
  completedSessions?: number,
  groupTotalSessions?: number,
): ManageTimingsSubject {
  const eventDetails = getEventDetails(appointment);
  const schedulingPeriod = getSchedulingPeriod(appointment);

  return {
    title: eventDetails.title,
    description: getDescription(
      appointment,
      eventDetails,
      completedSessions,
      groupTotalSessions,
    ),
    classInfo:
      appointment.appointmentType === "CLASS"
        ? {
            planType: eventDetails.planType ?? "Custom",
            sessionsPerWeek: eventDetails.sessionsPerWeek ?? 1,
            durationInMonths: eventDetails.durationInMonths,
            durationInHours: eventDetails.durationInHours,
          }
        : undefined,
    subject: {
      consultantProfileId: consultantId,
      eventType: eventDetails.eventType,
      eventId: eventDetails.eventId,
      durationInMonths: eventDetails.durationInMonths,
      sessionsPerWeek: eventDetails.sessionsPerWeek,
      // One duration field, two meanings — see time-picker-subject.ts.
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
      slots: appointment.slots,
    },
  };
}
