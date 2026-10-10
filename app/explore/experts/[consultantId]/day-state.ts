import { isSameDay, startOfDay } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type { DayOfWeek } from "@prisma/client";
import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
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
