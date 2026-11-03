import { calendarDateKey, calendarDayOf } from "@/lib/time/grid-zone";
import {
  isBookableWindow,
  windowsForDay,
  type GridAtomInput,
} from "@/lib/scheduling/booking-windows";

/** The part of a grid slot the day mark needs. */
export type DayMarkSlot = GridAtomInput;

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

type RawDaySlotsInput =
  | Date
  | readonly DayMarkSlot[]
  | Record<string, readonly DayMarkSlot[]>
  | null
  | undefined;

function resolveDaySlots(
  date: Date,
  rawSlots: RawDaySlotsInput,
): readonly DayMarkSlot[] | null {
  if (rawSlots === null || rawSlots === undefined || rawSlots instanceof Date) {
    return null;
  }
  if (Array.isArray(rawSlots)) {
    return rawSlots as readonly DayMarkSlot[];
  }
  const byDay = rawSlots as Record<string, readonly DayMarkSlot[]>;
  return byDay[calendarDateKey(date)] ?? [];
}

/**
 * A day is bookable when the slot list would offer at least one time on it:
 * the same windows (`windowsForDay`) and the same predicate
 * (`isBookableWindow`) — not past or too soon, not fully booked, not over a
 * plan limit, and for a plan longer than half an hour a contiguous run of
 * that length. A contended time still counts: the list offers it as
 * "Request". `date` is a calendar date (its local fields are read) and
 * "today" is today in `timezone`. `daySlots` is `null` while the month's
 * marks are unavailable.
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

  const daySlots = resolveDaySlots(date, rawSlots);
  const dayKey = calendarDateKey(date);
  const todayKey = calendarDateKey(calendarDayOf(now, timezone));
  const today = dayKey === todayKey;
  if (dayKey < todayKey) return "past";
  if (daySlots === null) return today ? "today+unknown" : "unknown";

  const bookable = windowsForDay(
    daySlots,
    durationInHours,
    timezone,
    now.getTime(),
  ).some(isBookableWindow);

  if (today) return bookable ? "today+bookable" : "today+none";
  return bookable ? "bookable" : "none";
}

/** A cell the consultee can select: not past, and not known to be empty. */
export function isSelectableDay(state: DayState): boolean {
  return state !== "past" && state !== "none" && state !== "today+none";
}
