import type { BookingOpsView } from "@/lib/backoffice/booking-ops-types";
import type { Door } from "./DoorDialog";

type RemovedSeat = BookingOpsView["removedSeats"][number];

/** The staff "Allow back" door: it lifts the block only, and says what the attendee can do next. */
export function seatLiftDoor(appointmentId: string, seat: RemovedSeat): Door {
  const who = seat.name?.trim() || "this attendee";
  const next = seat.paidSeat
    ? "Their seat was paid for, and a paid seat can't be bought again on their own yet, so they'll be told support will help them rejoin."
    : "They'll be told they can register again while seats are left.";
  const why = {
    CONDUCT:
      " Their call block is lifted too. The decision on the removal case stays as it is.",
    LEGACY:
      " They left before seat history was kept, so nothing records why; check before you let them back.",
    ORGANISER: "",
  }[seat.removal];
  return {
    url: `/api/staff/appointments/${encodeURIComponent(appointmentId)}/seats/lift`,
    title: `Allow ${who} back`,
    description: `This lifts the block on rejoining; it gives no seat back. ${next}${why}`,
    confirm: "Allow back",
    body: { userId: seat.userId },
  };
}
