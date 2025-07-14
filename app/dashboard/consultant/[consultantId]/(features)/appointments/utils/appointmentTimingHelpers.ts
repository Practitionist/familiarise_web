import { TAppointment } from "@/types/appointment";

export interface AppointmentTimingDetails {
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId: string;
  callsPerWeek: number;
  durationInMonths: number;
  durationInHours: number;
  title: string;
  canManageTimings: boolean;
}

/**
 * Extracts timing details from an appointment for use with EventTimingsCalendar
 */
export function getAppointmentTimingDetails(
  appointment: TAppointment,
): AppointmentTimingDetails {
  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return {
        eventType: "consultation",
        eventId: appointment.consultation?.id || "",
        callsPerWeek: 1, // Consultations are one-time events
        durationInMonths: 1, // Consultations are one-time events
        durationInHours:
          appointment.consultation?.consultationPlan?.durationInHours || 1,
        title:
          appointment.consultation?.consultationPlan?.title || "Consultation",
        canManageTimings: !!appointment.consultation?.id,
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
          appointment.subscription?.subscriptionPlan?.sessionDurationInHours ||
          1,
        title:
          appointment.subscription?.subscriptionPlan?.title || "Subscription",
        canManageTimings: !!appointment.subscription?.id,
      };
    case "WEBINAR":
      return {
        eventType: "webinar",
        eventId: appointment.webinar?.id || "",
        callsPerWeek: 1, // Webinars are one-time events
        durationInMonths: 1, // Webinars are one-time events
        durationInHours: appointment.webinar?.webinarPlan?.durationInHours || 1,
        title: appointment.webinar?.webinarPlan?.title || "Webinar",
        canManageTimings: !!appointment.webinar?.id,
      };
    case "CLASS": {
      // Calculate session duration for classes since ClassPlan doesn't have sessionDurationInHours
      const classPlan = appointment.class?.classPlan;
      const callsPerWeek = classPlan?.callsPerWeek || 1;
      const durationInMonths = classPlan?.durationInMonths || 1;

      // Use a reasonable default session duration
      // Since classContents is not available in TAppointment type, use smart defaults
      let sessionDurationInHours = 1.5; // Default for classes

      // For classes, we can estimate based on duration and frequency
      if (durationInMonths > 1 && callsPerWeek > 1) {
        // For longer, more frequent classes, use slightly longer sessions
        sessionDurationInHours = 2.0;
      } else if (durationInMonths > 6) {
        // For very long courses, use standard session length
        sessionDurationInHours = 1.5;
      }

      return {
        eventType: "class",
        eventId: appointment.class?.id || "",
        callsPerWeek,
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
        callsPerWeek: 1,
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

/**
 * Gets the display name for an appointment's timing management
 */
export function getAppointmentTimingDisplayName(
  appointment: TAppointment,
): string {
  const details = getAppointmentTimingDetails(appointment);
  return `${details.title} Timings`;
}
