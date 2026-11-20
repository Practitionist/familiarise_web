// The appointment lock every seat removal and lift takes, so their writes and their instants never interleave.

import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  renewAppointmentLock,
  withAppointmentLock,
  type ApprovalLock,
} from "@/utils/appointmentlock";
import { BookingRuleError } from "./booking-rule-error";

/** Runs `fn` under the event appointment's lock; a busy or unreachable lock is a typed 409. */
export async function withEventSeatLock<T>(
  appointmentId: string,
  fn: (renew: () => Promise<void>) => Promise<T>,
): Promise<T> {
  try {
    return await withAppointmentLock(appointmentId, (lock: ApprovalLock) =>
      fn(() => renewAppointmentLock(lock)),
    );
  } catch (error) {
    if (
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      throw new BookingRuleError(
        "EVENT_BUSY",
        "This event's attendee list is being changed right now. Try again in a moment.",
      );
    }
    throw error;
  }
}
