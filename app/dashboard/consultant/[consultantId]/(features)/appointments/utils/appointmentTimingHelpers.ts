import { TAppointment } from "@/types/appointment";

interface AppointmentTimingDetails {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  /** Sessions per week; 1 for the one-off event types. */
  sessionsPerWeek: number;
  durationInMonths: number;
  durationInHours: number;
  title: string;
  canManageTimings: boolean;
}

/**
 * Extracts timing details from an appointment for use with EventTimingsCalendar
 */
function getAppointmentTimingDetails(
  appointment: TAppointment,
): AppointmentTimingDetails {
  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return {
        eventType: "consultation",
        eventId: appointment.consultation?.id || "",
        sessionsPerWeek: 1, // Consultations are one-time events
        durationInMonths: 1, // Consultations are one-time events
        durationInHours:
          appointment.consultation?.consultationPlan?.durationInHours || 1,
        title:
          appointment.consultation?.consultationPlan?.title || "Consultation",
        canManageTimings: !!appointment.consultation?.id,
      };
    case "SUBSCRIPTION": {
      const sessionsPerWeek =
        appointment.subscription?.subscriptionPlan?.sessionsPerWeek || 1;
      return {
        eventType: "subscription",
        eventId: appointment.subscription?.id || "",
        sessionsPerWeek,
        durationInMonths:
          appointment.subscription?.subscriptionPlan?.durationInMonths || 1,
        durationInHours:
          appointment.subscription?.subscriptionPlan?.sessionDurationInHours ||
          1,
        title:
          appointment.subscription?.subscriptionPlan?.title || "Subscription",
        canManageTimings: !!appointment.subscription?.id,
      };
    }
    case "WEBINAR":
      return {
        eventType: "webinar",
        eventId: appointment.webinar?.id || "",
        sessionsPerWeek: 1, // Webinars are one-time events
        durationInMonths: 1, // Webinars are one-time events
        durationInHours: appointment.webinar?.webinarPlan?.durationInHours || 1,
        title: appointment.webinar?.webinarPlan?.title || "Webinar",
        canManageTimings: !!appointment.webinar?.id,
      };
    case "CLASS": {
      // Calculate session duration for classes
      const classPlan = appointment.class?.classPlan;
      const sessionsPerWeek = classPlan?.sessionsPerWeek || 1;
      const durationInMonths = classPlan?.durationInMonths || 1;

      // Use a reasonable default session duration
      // Since classContents is not available in TAppointment type, use smart defaults
      let sessionDurationInHours = 1.5; // Default for classes

      // For classes, we can estimate based on duration and frequency
      if (durationInMonths > 1 && sessionsPerWeek > 1) {
        // For longer, more frequent classes, use slightly longer sessions
        sessionDurationInHours = 2.0;
      } else if (durationInMonths > 6) {
        // For very long courses, use standard session length
        sessionDurationInHours = 1.5;
      }

      return {
        eventType: "class",
        eventId: appointment.class?.id || "",
        sessionsPerWeek,
        durationInMonths,
        durationInHours: sessionDurationInHours,
        title: appointment.class?.classPlan?.title || "Class",
        canManageTimings: !!appointment.class?.id,
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
        canManageTimings: false,
      };
  }
}

/**
 * Checks if an appointment supports timing management
 */
export function canManageAppointmentTimings(
  appointment: TAppointment,
): boolean {
  const details = getAppointmentTimingDetails(appointment);
  return details.canManageTimings;
}

/**
 * Checks if a group of appointments supports timing management
 * Used for recurring events (subscriptions, classes) to show timing management at group level
 */
export function canManageGroupTimings(
  groupAppointments: TAppointment[],
): boolean {
  if (!groupAppointments || groupAppointments.length === 0) {
    return false;
  }

  // Check if any appointment in the group supports timing management
  // Use the first appointment as representative of the group
  const firstAppointment = groupAppointments[0];
  return canManageAppointmentTimings(firstAppointment);
}
