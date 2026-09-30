import { isSameDay, startOfDay } from "date-fns";
import type { BookingMode } from "@prisma/client";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { consultationCtaFor } from "@/lib/booking/booking-mode";
import type { TIntervalTiming } from "@/types/slots";

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

export type DayBookingKind = "instant" | "request" | null;

function buildDurationWindowsForMarks(
  apiSlots: readonly (TIntervalTiming & { isAllocated: boolean })[],
  durationInHours: number,
): Array<DayMarkSlot & { isAllocated: boolean }> {
  if (!apiSlots || apiSlots.length === 0) return [];
  const sortedSlots = [...apiSlots].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  // Merge consecutive unallocated slots so multi-hour consultations can span adjacent rows
  const mergedSlots: Array<TIntervalTiming & { isAllocated: boolean }> = [];
  let currentMerged = { ...sortedSlots[0] };
  for (let i = 1; i < sortedSlots.length; i++) {
    const currentSlot = sortedSlots[i];
    const currentMergedEnd = new Date(currentMerged.endsAt).getTime();
    const nextSlotStart = new Date(currentSlot.startsAt).getTime();
    if (
      currentMergedEnd === nextSlotStart &&
      !currentMerged.isAllocated &&
      !currentSlot.isAllocated
    ) {
      currentMerged = {
        ...currentMerged,
        endsAt: currentSlot.endsAt,
      };
    } else {
      mergedSlots.push(currentMerged);
      currentMerged = { ...currentSlot };
    }
  }
  mergedSlots.push(currentMerged);

  const slidingIntervalMillis = 30 * 60 * 1000;
  const durationInMillis = durationInHours * 60 * 60 * 1000;
  const result: Array<DayMarkSlot & { isAllocated: boolean }> = [];

  for (const slot of mergedSlots) {
    const slotStart = new Date(slot.startsAt).getTime();
    const slotEnd = new Date(slot.endsAt).getTime();

    let windowStart = slotStart;
    while (windowStart + durationInMillis <= slotEnd) {
      const windowEnd = windowStart + durationInMillis;
      const overlapping = apiSlots.filter((s) => {
        const sStart = new Date(s.startsAt).getTime();
        const sEnd = new Date(s.endsAt).getTime();
        return sStart < windowEnd && sEnd > windowStart;
      });

      let windowStatus: "available" | "partially-booked" | "fully-booked" =
        "available";
      let windowAllocated = false;

      if (overlapping.length > 0) {
        const hasFullyBooked = overlapping.some(
          (s) => s.bookingStatus === "fully-booked",
        );
        const hasPartiallyBooked = overlapping.some(
          (s) => s.bookingStatus === "partially-booked",
        );
        windowAllocated = overlapping.some((s) => s.isAllocated);

        if (overlapping.every((s) => s.bookingStatus === "fully-booked")) {
          windowStatus = "fully-booked";
        } else if (hasFullyBooked || hasPartiallyBooked) {
          windowStatus = "partially-booked";
        }
      }

      result.push({
        startsAt: new Date(windowStart).toISOString(),
        bookingStatus: windowStatus,
        isAllocated: windowAllocated,
      });

      windowStart += slidingIntervalMillis;
    }
  }

  return result;
}

/** Match the date's mark and booking path to the duration windows in the picker. */
export function durationDayMark(
  date: Date,
  now: Date,
  daySlots: (TIntervalTiming & { isAllocated: boolean })[] | null,
  durationInHours: number,
  _timezone: string,
  bookingMode: BookingMode,
  acceptingRequests: boolean,
): { state: DayState; kind: DayBookingKind } {
  if (!isSameDay(date, now) && startOfDay(date) < startOfDay(now)) {
    return { state: "past", kind: null };
  }
  if (daySlots === null) {
    return { state: dayState(date, now, null), kind: null };
  }

  const windows = buildDurationWindowsForMarks(daySlots, durationInHours);
  const cutoff = now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS;
  const actionableWindows = windows.filter((slot) => {
    if (
      slot.bookingStatus === "fully-booked" ||
      new Date(slot.startsAt).getTime() < cutoff
    ) {
      return false;
    }
    return (
      acceptingRequests ||
      consultationCtaFor(bookingMode, slot.isAllocated).action === "checkout"
    );
  });

  const hasInstantWindow = actionableWindows.some(
    (slot) =>
      consultationCtaFor(bookingMode, slot.isAllocated).action === "checkout",
  );

  return {
    state: dayState(date, now, actionableWindows),
    kind: hasInstantWindow
      ? "instant"
      : actionableWindows.length > 0
        ? "request"
        : null,
  };
}
