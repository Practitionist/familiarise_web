import { TAppointment } from "@/types/appointment";

/**
 * The roster page for a webinar or class appointment, or null for any other
 * type: consultations and subscriptions are 1-on-1 and have no roster.
 */
export const getParticipantManagementUrl = (
  appointment: TAppointment,
  consultantId: string,
): string | null => {
  const baseUrl = `/dashboard/consultant/${consultantId}/appointments/participants`;
  if (appointment.webinarId)
    return `${baseUrl}/webinars/${appointment.webinarId}`;
  if (appointment.classId) return `${baseUrl}/classes/${appointment.classId}`;
  return null;
};
