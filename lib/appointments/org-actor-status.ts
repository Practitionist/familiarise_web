import {
  bookingStatus,
  type BookingStatus,
  type BookingStatusFacts,
} from "./booking-status";
import { planEndedOf } from "./list-status-facts";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";

/** The facts the org operator detail adds to its metadata, read as the org list reads them. */
export function orgActorStatusFacts(
  appointment: TAppointmentDetail["appointment"],
  now: Date,
): Pick<BookingStatusFacts, "paid" | "parkedSessions" | "planEnded"> {
  return {
    // A settled charge, so a paid plan waiting for its times is not read as unpaid.
    paid: appointment.payment.some((p) => p.paymentStatus === "SUCCEEDED"),
    parkedSessions: appointment.parkedSessions,
    planEnded: planEndedOf(appointment.subscription, now),
  };
}

/** The org operator detail's status: the one status function with the metadata's facts. */
export function orgActorStatus(
  meta: Pick<
    BookingStatusFacts,
    "kind" | "source" | "paid" | "reschedule" | "parkedSessions" | "planEnded"
  > & { status: string | null },
): BookingStatus | null {
  return meta.status ? bookingStatus(meta, "ORG_ADMIN") : null;
}
