/**
 * Custom error classes for reschedule operations
 *
 * Benefits over string matching:
 * - Type-safe error handling with instanceof
 * - No brittleness from message text changes
 * - Structured error data for clients
 */

/**
 * Thrown when a reschedule is attempted within the restricted time window
 */
export class ReschedulePolicyError extends Error {
  constructor(
    public readonly hoursUntilSlot: number,
    public readonly minimumHoursRequired: number,
  ) {
    super(
      `Cannot reschedule within ${minimumHoursRequired} hours of the session. ` +
        `The earliest session starts in ${Math.max(0, Math.floor(hoursUntilSlot))} hours.`,
    );
    this.name = "ReschedulePolicyError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ReschedulePolicyError);
    }
  }
}

/**
 * Thrown when an appointment or slot is not found
 */
export class AppointmentNotFoundError extends Error {
  constructor(
    public readonly resourceType: "appointment" | "slot",
    public readonly resourceId: string,
  ) {
    const message =
      resourceType === "appointment"
        ? "Appointment not found"
        : "Specified slot not found in this appointment";
    super(message);
    this.name = "AppointmentNotFoundError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppointmentNotFoundError);
    }
  }
}
