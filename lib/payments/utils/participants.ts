/**
 * Participant Counting Utility
 * OPT-2: Extracted common participant counting logic to prevent duplication
 */

/**
 * Type guard to check if a value is an object with an id property
 * TYPE-2: Provides type safety for user arrays from slot data
 */
export function isUserWithId(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && "id" in value;
}

/**
 * Count unique participants across multiple appointments
 * Used for CLASS checkout where users join all sessions
 *
 * @param appointments - Array of appointments with slots and users
 * @returns Number of unique participants
 */
export function countUniqueParticipants(
  appointments: Array<{
    slotsOfAppointment: Array<{ user?: Array<{ id: string }> | unknown }>;
  }>,
  excludeUserIds: string[] = [],
): number {
  const uniqueUserIds = new Set<string>();

  for (const apt of appointments) {
    for (const slot of apt.slotsOfAppointment) {
      if (Array.isArray(slot.user)) {
        slot.user
          .filter(isUserWithId)
          .filter((u) => !excludeUserIds.includes(u.id))
          .forEach((u) => uniqueUserIds.add(u.id));
      }
    }
  }

  return uniqueUserIds.size;
}

/**
 * Count participants for a single appointment (webinar)
 * For webinars, there's typically one slot with multiple users
 *
 * @param appointment - Single appointment with slots
 * @returns Number of unique participants across all slots
 */
export function countWebinarParticipants(
  appointment: any,
  excludeUserIds: string[] = [],
): number {
  if (!appointment?.slotsOfAppointment) return 0;

  // Count users across all slots (webinars have 1 slot with many users)
  const uniqueUserIds = new Set<string>();
  for (const slot of appointment.slotsOfAppointment) {
    if (Array.isArray(slot.user)) {
      slot.user
        .filter(isUserWithId)
        .filter((u: { id: string }) => !excludeUserIds.includes(u.id))
        .forEach((u: { id: string }) => uniqueUserIds.add(u.id));
    }
  }
  return uniqueUserIds.size;
}

/**
 * Check if user is already enrolled in a set of appointments
 * Used for CLASS enrollment validation
 *
 * @param appointments - Array of appointments with slots and users
 * @param userId - User ID to check
 * @returns True if user is already enrolled
 */
export function isUserEnrolled(
  appointments: Array<{
    slotsOfAppointment: Array<{ user?: Array<{ id: string }> | unknown }>;
  }>,
  userId: string,
): boolean {
  for (const apt of appointments) {
    for (const slot of apt.slotsOfAppointment) {
      if (Array.isArray(slot.user)) {
        if (slot.user.filter(isUserWithId).some((u) => u.id === userId)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Check if user is already registered for a webinar
 * Used for WEBINAR registration validation
 *
 * @param webinars - Array of webinar instances with appointments
 * @param userId - User ID to check
 * @returns True if user is already registered
 */
export function isUserRegisteredForWebinar(
  webinars: Array<{
    appointment?: {
      slotsOfAppointment?: Array<{ user?: Array<{ id: string }> | unknown }>;
    } | null;
  }>,
  userId: string,
): boolean {
  for (const webinar of webinars) {
    if (!webinar.appointment?.slotsOfAppointment) continue;
    for (const slot of webinar.appointment.slotsOfAppointment) {
      if (Array.isArray(slot.user)) {
        if (slot.user.filter(isUserWithId).some((u) => u.id === userId)) {
          return true;
        }
      }
    }
  }
  return false;
}
