import {
  MINIMUM_BOOKING_LEAD_TIME_MS,
  MINIMUM_BOOKING_LEAD_TIME_MINUTES,
} from "@/lib/payments/constants";

/**
 * Validates slot timing - returns error message if invalid, null if valid
 */
export function validateSlotTiming(slotStart: Date): string | null {
  const now = new Date();

  if (slotStart < now) {
    return "This time slot has already passed";
  }

  const minimumBookingTime = new Date(
    now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS
  );
  if (slotStart < minimumBookingTime) {
    const minutesUntilSlot = Math.ceil(
      (slotStart.getTime() - now.getTime()) / (60 * 1000)
    );
    return `This time slot starts too soon (in ${minutesUntilSlot} minute${minutesUntilSlot === 1 ? "" : "s"}). Bookings must be made at least ${MINIMUM_BOOKING_LEAD_TIME_MINUTES} minutes in advance.`;
  }

  return null;
}
