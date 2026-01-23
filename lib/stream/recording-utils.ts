/**
 * Recording Utility Functions
 * Shared helpers for recording-related operations
 */

/**
 * Type for appointment with ownership relations
 * Used for checking if a consultant owns a recording/session
 */
export interface AppointmentWithOwnership {
  webinar?: {
    webinarPlan?: {
      consultantProfileId: string | null;
      recordingEnabled?: boolean;
    } | null;
  } | null;
  class?: {
    classPlan?: {
      consultantProfileId: string | null;
      recordingEnabled?: boolean;
    } | null;
  } | null;
}

/**
 * Check if a consultant owns an appointment (webinar or class)
 *
 * @param appointment - The appointment with webinar/class plan relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns true if the consultant owns the appointment
 */
export function isAppointmentOwner(
  appointment: AppointmentWithOwnership | null | undefined,
  consultantProfileId: string | null | undefined,
): boolean {
  if (!appointment || !consultantProfileId) {
    return false;
  }

  // Check webinar ownership
  if (appointment.webinar?.webinarPlan) {
    return (
      appointment.webinar.webinarPlan.consultantProfileId ===
      consultantProfileId
    );
  }

  // Check class ownership
  if (appointment.class?.classPlan) {
    return (
      appointment.class.classPlan.consultantProfileId === consultantProfileId
    );
  }

  return false;
}

/**
 * Check if recording is enabled for an appointment
 *
 * @param appointment - The appointment with webinar/class plan relations
 * @returns true if recording is enabled for this appointment's plan
 */
export function isRecordingEnabledForAppointment(
  appointment: AppointmentWithOwnership | null | undefined,
): boolean {
  if (!appointment) {
    return false;
  }

  // Check webinar plan
  if (appointment.webinar?.webinarPlan) {
    return appointment.webinar.webinarPlan.recordingEnabled === true;
  }

  // Check class plan
  if (appointment.class?.classPlan) {
    return appointment.class.classPlan.recordingEnabled === true;
  }

  return false;
}

/**
 * Get ownership info from a recording with nested relations
 *
 * @param recording - Recording with meetingSession -> slotOfAppointment -> appointment relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns Object with isOwner and recordingEnabled flags
 */
export function getRecordingOwnershipInfo(
  recording: {
    meetingSession?: {
      slotOfAppointment?: {
        appointment?: AppointmentWithOwnership | null;
      } | null;
    } | null;
  } | null,
  consultantProfileId: string | null | undefined,
): { isOwner: boolean; recordingEnabled: boolean } {
  const appointment = recording?.meetingSession?.slotOfAppointment?.appointment;

  return {
    isOwner: isAppointmentOwner(appointment, consultantProfileId),
    recordingEnabled: isRecordingEnabledForAppointment(appointment),
  };
}

/**
 * Get ownership info from a meeting session with nested relations
 *
 * @param meetingSession - MeetingSession with slotOfAppointment -> appointment relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns Object with isOwner and recordingEnabled flags
 */
export function getMeetingSessionOwnershipInfo(
  meetingSession: {
    slotOfAppointment?: {
      appointment?: AppointmentWithOwnership | null;
    } | null;
  } | null,
  consultantProfileId: string | null | undefined,
): { isOwner: boolean; recordingEnabled: boolean } {
  const appointment = meetingSession?.slotOfAppointment?.appointment;

  return {
    isOwner: isAppointmentOwner(appointment, consultantProfileId),
    recordingEnabled: isRecordingEnabledForAppointment(appointment),
  };
}
