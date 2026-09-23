import { isSameDay, startOfDay } from "date-fns";
import type { BookingMode } from "@prisma/client";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { consultationCtaFor } from "@/lib/booking/booking-mode";
import type { TIntervalTiming } from "@/types/slots";
import { breakDownSlotsPreservingStatus } from "@/utils/scheduling-engine/intervals";

/** The part of a grid slot the day mark needs. */
export interface DayMarkSlot {
  startsAt: string;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
}

/**
 * What a day cell of the booking calendar is (#1785 L-4). `unknown` is the
 * month read still loading or failed — the cell stays clickable and unmarked,
 * because a missing mark must never block picking a day.
 */
export type DayState =
  | "past"
  | "none"
  | "bookable"
  | "unknown"
  | "today+bookable"
  | "today+none"
  | "today+unknown";

/**
 * A day is bookable when at least one of its slots is neither past (inside
 * the checkout lead time) nor fully booked — the cal.diy#2329 rule: published
 * hours alone do not earn the ring. `daySlots` is `null` while the month's
 * marks are unavailable.
 */
export function dayState(
  date: Date,
  now: Date,
  daySlots: readonly DayMarkSlot[] | null,
): DayState {
  const today = isSameDay(date, now);
  if (!today && startOfDay(date) < startOfDay(now)) return "past";
  if (daySlots === null) return today ? "today+unknown" : "unknown";
  const cutoff = now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS;
  const bookable = daySlots.some(
    (slot) =>
      slot.bookingStatus !== "fully-booked" &&
      new Date(slot.startsAt).getTime() >= cutoff,
  );
  if (today) return bookable ? "today+bookable" : "today+none";
  return bookable ? "bookable" : "none";
}

/** A cell the consultee can select: not past, and not known to be empty. */
export function isSelectableDay(state: DayState): boolean {
  return state !== "past" && state !== "none" && state !== "today+none";
}

/** Match the calendar mark to the duration windows actually shown in the picker. */
export function durationDayState(
  date: Date,
  now: Date,
  daySlots: (TIntervalTiming & { isAllocated: boolean })[] | null,
  durationInHours: number,
  timezone: string,
  bookingMode: BookingMode,
  acceptingRequests: boolean,
): DayState {
  if (!isSameDay(date, now) && startOfDay(date) < startOfDay(now)) {
    return "past";
  }
  if (daySlots === null) return dayState(date, now, null);

  const windows = breakDownSlotsPreservingStatus(
    daySlots,
    durationInHours,
    timezone,
  );
  const actionableWindows = acceptingRequests
    ? windows
    : windows.filter(
        (slot) =>
          consultationCtaFor(bookingMode, slot.isAllocated).action ===
          "checkout",
      );

  return dayState(date, now, actionableWindows);
}
