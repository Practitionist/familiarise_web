/**
 * Recording Utility Functions
 * Shared helpers for recording-related operations
 */

import prisma from "@/lib/prisma";

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
/**
 * Appointment shape for title generation (includes plan titles for all event types)
 */
interface AppointmentWithTitles {
  webinar?: { webinarPlan?: { title?: string } | null } | null;
  class?: { classPlan?: { title?: string } | null } | null;
  consultation?: { consultationPlan?: { title?: string } | null } | null;
  subscription?: { subscriptionPlan?: { title?: string } | null } | null;
}

/**
 * Generate a recording title from appointment info and date.
 * Shared across recording handlers and sync functions to avoid duplication.
 */
export function generateRecordingTitle(
  appointment: AppointmentWithTitles | null | undefined,
  recordedAt: Date,
): string {
  let title = "Recording";

  if (appointment?.webinar?.webinarPlan?.title) {
    title = `Webinar: ${appointment.webinar.webinarPlan.title}`;
  } else if (appointment?.class?.classPlan?.title) {
    title = `Class: ${appointment.class.classPlan.title}`;
  } else if (appointment?.consultation?.consultationPlan?.title) {
    title = `Consultation: ${appointment.consultation.consultationPlan.title}`;
  } else if (appointment?.subscription?.subscriptionPlan?.title) {
    title = `Subscription: ${appointment.subscription.subscriptionPlan.title}`;
  }

  const dateStr = recordedAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${title} - ${dateStr}`;
}

/**
 * Get all attendee user IDs for a webinar or class event.
 * Queries appointment slot users and booked waitlist users in parallel.
 */
export async function getEventAttendeeIds(
  appointment: {
    webinar?: { id: string } | null;
    class?: { id: string } | null;
  } | null | undefined,
  existingUserIds: string[] = [],
): Promise<string[]> {
  if (!appointment) return existingUserIds;

  if (appointment.webinar) {
    const [slotUsers, waitlistEntries] = await Promise.all([
      prisma.slotOfAppointment.findMany({
        where: { appointment: { webinarId: appointment.webinar.id } },
        select: { user: { select: { id: true } } },
      }),
      prisma.waitlist.findMany({
        where: { webinarId: appointment.webinar.id, status: "BOOKED" },
        select: { userId: true },
      }),
    ]);
    return Array.from(new Set([
      ...existingUserIds,
      ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
      ...waitlistEntries.map((w) => w.userId),
    ]));
  }

  if (appointment.class) {
    const [slotUsers, waitlistEntries] = await Promise.all([
      prisma.slotOfAppointment.findMany({
        where: { appointment: { classId: appointment.class.id } },
        select: { user: { select: { id: true } } },
      }),
      prisma.waitlist.findMany({
        where: { classId: appointment.class.id, status: "BOOKED" },
        select: { userId: true },
      }),
    ]);
    return Array.from(new Set([
      ...existingUserIds,
      ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
      ...waitlistEntries.map((w) => w.userId),
    ]));
  }

  return existingUserIds;
}

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
