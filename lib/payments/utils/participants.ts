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
  }>
): number {
  const uniqueUserIds = new Set<string>();

  for (const apt of appointments) {
    for (const slot of apt.slotsOfAppointment) {
      if (Array.isArray(slot.user)) {
        slot.user.filter(isUserWithId).forEach((u) => uniqueUserIds.add(u.id));
      }
    }
  }

  return uniqueUserIds.size;
}

/**
 * Count participants for a single appointment (webinar)
 * Wrapper for countUniqueParticipants with single appointment
 *
 * @param appointment - Single appointment with slots
 * @returns Number of participants (slots with users)
 */
export function countWebinarParticipants(
  appointment: {
    slotsOfAppointment?: Array<{ user?: Array<{ id: string }> | unknown }>;
  } | null
): number {
  if (!appointment?.slotsOfAppointment) return 0;

  // For webinars, each slot represents one participant booking
  return appointment.slotsOfAppointment.length;
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
  userId: string
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
