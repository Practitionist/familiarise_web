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
 * Thrown when the caller is not authorized to reschedule an appointment
 */
export class RescheduleAuthorizationError extends Error {
  constructor() {
    super("You are not authorized to reschedule this appointment");
    this.name = "RescheduleAuthorizationError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RescheduleAuthorizationError);
    }
  }
}

/**
 * Thrown when the query param type doesn't match the DB-derived appointment type
 */
export class AppointmentTypeMismatchError extends Error {
  constructor(
    public readonly queryType: string,
    public readonly derivedType: string,
  ) {
    super(
      `Appointment type mismatch: query param "${queryType}" does not match actual type "${derivedType}"`,
    );
    this.name = "AppointmentTypeMismatchError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppointmentTypeMismatchError);
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
