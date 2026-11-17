import {
  bookingStatus,
  type BookingStatus,
} from "@/lib/appointments/booking-status";
import type { CaseBooking } from "@/types/support-case";

/** The case drawer's booking status: the lists' status function with the same facts. */
export function caseBookingStatus(booking: CaseBooking): BookingStatus | null {
  if (!booking.status) return null;
  return bookingStatus(
    {
      kind: booking.kind,
      status: booking.status,
      seatStatus: booking.seatStatus,
      ...booking.facts,
    },
    "STAFF",
  );
}
