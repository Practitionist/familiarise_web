import { TAppointment } from "@/types/appointment";

// Get the participant management URL for an appointment
export const getParticipantManagementUrl = (
  appointment: TAppointment,
  consultantId: string,
): string => {
  const baseUrl = `/dashboard/consultant/${consultantId}/appointments/participants`;

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return `${baseUrl}/consultations/${appointment.consultationId}`;
    case "SUBSCRIPTION":
      return `${baseUrl}/subscriptions/${appointment.subscriptionId}`;
    case "WEBINAR":
      return `${baseUrl}/webinars/${appointment.webinarId}`;
    case "CLASS":
      return `${baseUrl}/classes/${appointment.classId}`;
    default:
      return "#";
  }
};

// Check if an appointment type supports participant management
export const supportsParticipantManagement = (
  appointment: TAppointment,
): boolean => {
  return !!(
    appointment.subscriptionId ||
    appointment.webinarId ||
    appointment.classId
  );
};
