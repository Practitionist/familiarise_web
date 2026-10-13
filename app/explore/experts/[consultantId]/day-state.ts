import { isSameDay, startOfDay } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type { BookingMode, DayOfWeek } from "@prisma/client";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import { consultationCtaFor } from "@/lib/booking/booking-mode";
import {
  breakDownSlotsPreservingStatus,
  type BookingStatus,
} from "@/utils/scheduling-engine/intervals";
import type { TIntervalTiming } from "@/types/slots";

/** The part of a grid slot the day mark needs. */
export interface DayMarkSlot {
  startsAt: string;
  endsAt?: string;
  isAllocated?: boolean;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  slotId?: string;
  availabilityWindowId?: string;
  dayOfWeek?: DayOfWeek;
  localStartTime?: string;
  localEndTime?: string;
  type?: "WEEKLY" | "CUSTOM";
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

function normalizeSlotForBreakdown(
  slot: DayMarkSlot,
  index: number,
): TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
} {
  const startMs = new Date(slot.startsAt).getTime();
  const endsAt =
    slot.endsAt ?? new Date(startMs + 30 * 60 * 1000).toISOString();
  const bookingStatus: BookingStatus = slot.bookingStatus ?? "available";
  const isAllocated = slot.isAllocated ?? bookingStatus !== "available";
  return {
    slotId: slot.slotId ?? `day-mark-${index}-${startMs}`,
    dateInISO: slot.startsAt,
    startsAt: slot.startsAt,
    endsAt,
    dayOfWeek: slot.dayOfWeek ?? ("MONDAY" as DayOfWeek),
    availabilityWindowId: slot.availabilityWindowId ?? "day-mark-window",
    appointmentOccurrenceId: "",
    localStartTime: slot.localStartTime ?? "00:00",
    localEndTime: slot.localEndTime ?? "00:30",
    type: slot.type ?? "WEEKLY",
    isAllocated,
    bookingStatus,
  };
}

type RawDaySlotsInput =
  | Date
  | readonly DayMarkSlot[]
  | Record<string, readonly DayMarkSlot[]>
  | null
  | undefined;

function resolveDaySlots(
  date: Date,
  rawSlots: RawDaySlotsInput,
  timezone: string,
): readonly DayMarkSlot[] | null {
  if (rawSlots === null || rawSlots === undefined || rawSlots instanceof Date) {
    return null;
  }
  if (Array.isArray(rawSlots)) {
    return rawSlots as readonly DayMarkSlot[];
  }
  const key = formatInTimeZone(date, timezone, "yyyy-MM-dd");
  return (rawSlots as Record<string, readonly DayMarkSlot[]>)[key] ?? [];
}

function hasBookableSlot(
  daySlots: readonly DayMarkSlot[],
  durationInHours: number,
  timezone: string,
  cutoff: number,
): boolean {
  if (durationInHours > 0.5) {
    const normalized = daySlots.map((slot, idx) =>
      normalizeSlotForBreakdown(slot, idx),
    );
    const contiguousWindows = breakDownSlotsPreservingStatus(
      normalized,
      durationInHours,
      timezone,
    );
    return contiguousWindows.some(
      (slot) =>
        slot.bookingStatus === "available" &&
        new Date(slot.startsAt).getTime() >= cutoff,
    );
  }
  return daySlots.some(
    (slot) =>
      !slot.isAllocated &&
      (slot.bookingStatus ?? "available") === "available" &&
      new Date(slot.startsAt).getTime() >= cutoff,
  );
}

/**
 * A day is bookable when at least one of its slots is neither past (inside
 * the checkout lead time) nor fully booked — the cal.diy#2329 rule: published
 * hours alone do not earn the ring. `daySlots` is `null` while the month's
 * marks are unavailable.
 *
 * #1643 — when `durationInHours > 0.5`, uses `breakDownSlotsPreservingStatus`
 * to verify at least one contiguous session of `durationInHours` is
 * `"available"` and `>= cutoff`, so a day with only an isolated 30-min slot
 * is not falsely ringed as bookable for a 1h/2h consultation plan.
 */
export function dayState(
  date: Date,
  nowOrSlots:
    | Date
    | readonly DayMarkSlot[]
    | Record<string, readonly DayMarkSlot[]>
    | null,
  slotsOrNow:
    | readonly DayMarkSlot[]
    | Record<string, readonly DayMarkSlot[]>
    | Date
    | null,
  timezoneOrDuration: string | number = "UTC",
  maybeDuration?: number,
): DayState {
  const timezone =
    typeof timezoneOrDuration === "string"
      ? timezoneOrDuration || "UTC"
      : "UTC";
  const durationInHours =
    typeof timezoneOrDuration === "number"
      ? timezoneOrDuration
      : (maybeDuration ?? 0.5);

  const now = nowOrSlots instanceof Date ? nowOrSlots : (slotsOrNow as Date);
  const rawSlots = nowOrSlots instanceof Date ? slotsOrNow : nowOrSlots;

  const daySlots = resolveDaySlots(date, rawSlots, timezone);
  const today = isSameDay(date, now);
  if (!today && startOfDay(date) < startOfDay(now)) return "past";
  if (daySlots === null) return today ? "today+unknown" : "unknown";

  const cutoff = now.getTime() + MINIMUM_BOOKING_LEAD_TIME_MS;
  const bookable = hasBookableSlot(daySlots, durationInHours, timezone, cutoff);

  if (today) return bookable ? "today+bookable" : "today+none";
  return bookable ? "bookable" : "none";
}

/** A cell the consultee can select: not past, and not known to be empty. */
export function isSelectableDay(state: DayState): boolean {
  return state !== "past" && state !== "none" && state !== "today+none";
}

export type DayBookingKind = "instant" | "request" | null;

export type AllocatedSlot = TIntervalTiming & {
  isAllocated: boolean;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  availabilityWindowIds?: string[];
};

export type DurationWindowSlot = AllocatedSlot & {
  bookingStatus: "available" | "partially-booked" | "fully-booked";
};

function deriveWindowStatus(overlapping: readonly AllocatedSlot[]): {
  bookingStatus: "available" | "partially-booked" | "fully-booked";
  isAllocated: boolean;
} {
  if (overlapping.length === 0) {
    return { bookingStatus: "available", isAllocated: false };
  }

  const isAllocated = overlapping.some((s) => s.isAllocated);
  if (overlapping.every((s) => s.bookingStatus === "fully-booked")) {
    return { bookingStatus: "fully-booked", isAllocated };
  }

  const hasBookedSubSlot = overlapping.some(
    (s) =>
      s.bookingStatus === "fully-booked" ||
      s.bookingStatus === "partially-booked",
  );
  return {
    bookingStatus: hasBookedSubSlot ? "partially-booked" : "available",
    isAllocated,
  };
}

function mergeConsecutiveUnallocatedSlots(
  slots: readonly AllocatedSlot[],
): AllocatedSlot[] {
  const sortedSlots = [...slots].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const mergedSlots: AllocatedSlot[] = [];
  let currentMerged: AllocatedSlot = { ...sortedSlots[0] };

  for (let i = 1; i < sortedSlots.length; i++) {
    const currentSlot = sortedSlots[i];
    const isConsecutive =
      new Date(currentMerged.endsAt).getTime() ===
      new Date(currentSlot.startsAt).getTime();
    if (
      isConsecutive &&
      !currentMerged.isAllocated &&
      !currentSlot.isAllocated
    ) {
      const ids = new Set([
        ...(currentMerged.availabilityWindowIds ?? [
          currentMerged.availabilityWindowId,
        ]),
        ...(currentSlot.availabilityWindowIds ?? [
          currentSlot.availabilityWindowId,
        ]),
      ]);
      currentMerged = {
        ...currentMerged,
        endsAt: currentSlot.endsAt,
        localEndTime: currentSlot.localEndTime,
        availabilityWindowIds: [...ids],
      };
    } else {
      mergedSlots.push(currentMerged);
      currentMerged = { ...currentSlot };
    }
  }

  mergedSlots.push(currentMerged);
  return mergedSlots;
}

export function buildDurationWindowStarts(
  apiSlots: readonly AllocatedSlot[],
  durationInHours: number,
): DurationWindowSlot[] {
  if (!apiSlots || apiSlots.length === 0) return [];

  const mergedSlots = mergeConsecutiveUnallocatedSlots(apiSlots);
  const slidingIntervalMillis = 30 * 60 * 1000;
  const durationInMillis = durationInHours * 60 * 60 * 1000;
  const result: DurationWindowSlot[] = [];

  for (const slot of mergedSlots) {
    const slotStart = new Date(slot.startsAt).getTime();
    const slotEnd = new Date(slot.endsAt).getTime();

    for (
      let windowStart = slotStart;
      windowStart + durationInMillis <= slotEnd;
      windowStart += slidingIntervalMillis
    ) {
      const windowEnd = windowStart + durationInMillis;
      const overlapping = apiSlots.filter((s) => {
        const sStart = new Date(s.startsAt).getTime();
        const sEnd = new Date(s.endsAt).getTime();
        return sStart < windowEnd && sEnd > windowStart;
      });

      const { bookingStatus, isAllocated } = deriveWindowStatus(overlapping);
      result.push({
        ...slot,
        slotId: `${slot.availabilityWindowId}-${windowStart}`,
        startsAt: new Date(windowStart).toISOString(),
        endsAt: new Date(windowEnd).toISOString(),
        bookingStatus,
        isAllocated,
      });
    }
  }

  return result.sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}

function resolveDayBookingKind(
  hasInstantWindow: boolean,
  hasActionableWindows: boolean,
): DayBookingKind {
  if (hasInstantWindow) return "instant";
  if (hasActionableWindows) return "request";
  return null;
}

/** Match the date's mark and booking path to the duration windows in the picker. */
export function durationDayMark(
  date: Date,
  now: Date,
  daySlots: AllocatedSlot[] | null,
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

  const windows = buildDurationWindowStarts(daySlots, durationInHours);
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
  const hasActionableWindow = actionableWindows.length > 0;
  let state: DayState;
  if (isSameDay(date, now)) {
    state = hasActionableWindow ? "today+bookable" : "today+none";
  } else {
    state = hasActionableWindow ? "bookable" : "none";
  }

  return {
    state,
    kind: resolveDayBookingKind(hasInstantWindow, hasActionableWindow),
  };
}
