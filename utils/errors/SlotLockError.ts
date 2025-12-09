/**
 * Custom error class for slot booking lock failures
 *
 * Thrown when a slot is currently being booked by another user
 * and the lock cannot be acquired.
 *
 * Benefits over string matching:
 * - Type-safe error handling with instanceof
 * - No brittleness from message text changes
 * - Structured error data for clients
 */
export class SlotLockError extends Error {
  constructor(
    public readonly consultantId: string,
    public readonly slotTime: string,
    public readonly retryAfterSeconds: number = 15
  ) {
    super(
      `Slot ${slotTime} for consultant ${consultantId} is currently being booked by another user. Please try again in ${retryAfterSeconds} seconds.`
    );
    this.name = 'SlotLockError';

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SlotLockError);
    }
  }
}
