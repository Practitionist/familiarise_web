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
    now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS,
  );
  if (slotStart < minimumBookingTime) {
    const minutesUntilSlot = Math.ceil(
      (slotStart.getTime() - now.getTime()) / (60 * 1000),
    );
    return `This time slot starts too soon (in ${minutesUntilSlot} minute${minutesUntilSlot === 1 ? "" : "s"}). Bookings must be made at least ${MINIMUM_BOOKING_LEAD_TIME_MINUTES} minutes in advance.`;
  }

  return null;
}

/** The 30-minute grid every booking atom sits on (utils/appointmentlock SLOT_ATOM_MS). */
const SLOT_GRID_MS = 30 * 60 * 1000;

export const SLOT_NOT_ON_GRID_MESSAGE = "Times start on the hour or half hour";

/** The typed refusal codes a client-picked start can earn at the Zod edge. */
export type SlotStartRefusalCode = "SLOT_NOT_ON_GRID" | "SLOT_TOO_SOON";

/**
 * #1583 E-P1-03 / #1592 A-P1-04 — one edge check for every client-picked
 * start (request-for-approval and checkout): on the :00/:30 UTC grid, and at
 * least the checkout lead time ahead. The allocator's own re-validation keeps
 * its 5-second BUFFER_MS (ScheduleValidationService.validateSlotsInFuture)
 * because the slots it re-checks are server-picked moments earlier, not a
 * client's stale form; the two bounds are deliberately different.
 */
export function slotStartRefusal(
  slotStart: Date,
  now = new Date(),
): { code: SlotStartRefusalCode; message: string } | null {
  if (slotStart.getTime() % SLOT_GRID_MS !== 0) {
    return { code: "SLOT_NOT_ON_GRID", message: SLOT_NOT_ON_GRID_MESSAGE };
  }
  if (slotStart.getTime() <= now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS) {
    return {
      code: "SLOT_TOO_SOON",
      message:
        validateSlotTiming(slotStart) ??
        `Bookings must be made at least ${MINIMUM_BOOKING_LEAD_TIME_MINUTES} minutes in advance.`,
    };
  }
  return null;
}
