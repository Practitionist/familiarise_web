import { DayOfWeek } from "@prisma/client";
import { TWeeklySlot, TCustomSlot, TSlotTiming } from "@/types/slots";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";

export const dayMap: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

export const dayToNumber: Record<DayOfWeek, number> = {
  [DayOfWeek.SUNDAY]: 0,
  [DayOfWeek.MONDAY]: 1,
  [DayOfWeek.TUESDAY]: 2,
  [DayOfWeek.WEDNESDAY]: 3,
  [DayOfWeek.THURSDAY]: 4,
  [DayOfWeek.FRIDAY]: 5,
  [DayOfWeek.SATURDAY]: 6,
};

// Ensure UTC time is always a string
export function normalizeUTCTime(time: string | Date): string {
  return typeof time === "string" ? time : time.toISOString();
}

// Normalize weekly slot to ensure all times are strings
export function normalizeWeeklySlot(slot: TWeeklySlot): TWeeklySlot & {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
} {
  return {
    ...slot,
    slotStartTimeInUTC: normalizeUTCTime(slot.slotStartTimeInUTC),
    slotEndTimeInUTC: normalizeUTCTime(slot.slotEndTimeInUTC),
  };
}

// Normalize custom slot to ensure all times are strings
export function normalizeCustomSlot(slot: TCustomSlot): TCustomSlot & {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
} {
  return {
    ...slot,
    slotStartTimeInUTC: normalizeUTCTime(slot.slotStartTimeInUTC),
    slotEndTimeInUTC: normalizeUTCTime(slot.slotEndTimeInUTC),
  };
}

export function formatTime(date: Date, timezone?: string | null): string {
  if (!timezone) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: true,
    });
  }

  const zonedDate = toZonedTime(date, timezone);
  return format(zonedDate, "h:mm a");
}

export function getLocalDay(date: Date, timezone?: string | null): number {
  if (!timezone) return date.getDay();

  try {
    const localDate = new Date(
      date.toLocaleString("en-US", { timeZone: timezone }),
    );
    return localDate.getDay();
  } catch (_) {
    console.warn("Invalid timezone, using UTC day");
    return date.getUTCDay();
  }
}

export function createWeeklySlot(
  slot: TWeeklySlot,
  selectedDate: Date,
  startDateTime: Date,
  endDateTime: Date,
  timezone?: string | null,
): TSlotTiming {
  const localDay = getLocalDay(selectedDate, timezone);
  const selectedDayOfWeek = dayMap[localDay];

  return {
    slotId: slot.id,
    dateInISO: selectedDate.toISOString(),
    dayOfWeek: selectedDayOfWeek,
    slotStartTimeInUTC: startDateTime.toISOString(),
    slotEndTimeInUTC: endDateTime.toISOString(),
    slotOfAvailabilityId: slot.id,
    slotOfAppointmentId: "", // Not an appointment
    localStartTime: formatTime(startDateTime, timezone),
    localEndTime: formatTime(endDateTime, timezone),
  };
}

export function createCustomSlot(
  slot: TCustomSlot,
  selectedDate: Date,
  startDateTime: Date,
  endDateTime: Date,
  timezone?: string | null,
): TSlotTiming {
  let adjustedEndDateTime = new Date(endDateTime);
  const normalizedSlot = normalizeCustomSlot(slot);

  // Handle slots that cross midnight
  if (
    endDateTime <= startDateTime ||
    (endDateTime.getHours() === 0 && endDateTime.getMinutes() === 0)
  ) {
    adjustedEndDateTime = new Date(endDateTime);
    adjustedEndDateTime.setDate(adjustedEndDateTime.getDate() + 1);
  }

  const slotTiming = {
    slotId: normalizedSlot.id,
    dateInISO: selectedDate.toISOString(),
    dayOfWeek: dayMap[getLocalDay(startDateTime, timezone)],
    slotStartTimeInUTC: startDateTime.toISOString(),
    slotEndTimeInUTC: adjustedEndDateTime.toISOString(),
    slotOfAvailabilityId: normalizedSlot.id,
    slotOfAppointmentId: "",
    localStartTime: formatTime(startDateTime, timezone),
    localEndTime: formatTime(adjustedEndDateTime, timezone),
  };

  console.log("Created custom slot:", {
    utcStart: normalizedSlot.slotStartTimeInUTC,
    utcEnd: normalizedSlot.slotEndTimeInUTC,
    localStart: slotTiming.localStartTime,
    localEnd: slotTiming.localEndTime,
    timezone,
    crossesMidnight: adjustedEndDateTime.getDate() > startDateTime.getDate(),
  });

  return slotTiming;
}

export function mergeOverlappingSlots(
  slots: TSlotTiming[],
  timezone?: string | null,
): TSlotTiming[] {
  // Don't merge slots that are more than 1 minute apart
  return slots.reduce((acc: TSlotTiming[], curr) => {
    if (acc.length === 0) return [curr];

    const last = acc[acc.length - 1];
    const lastEnd = new Date(last.slotEndTimeInUTC);
    const currStart = new Date(curr.slotStartTimeInUTC);
    const currEnd = new Date(curr.slotEndTimeInUTC);

    // Only merge if the slots are exactly adjacent (less than 1 minute apart)
    const diffInMinutes =
      (currStart.getTime() - lastEnd.getTime()) / (1000 * 60);
    if (diffInMinutes <= 0) {
      // If current slot ends after the last slot
      if (currEnd > lastEnd) {
        last.slotEndTimeInUTC = curr.slotEndTimeInUTC;
        last.localEndTime = formatTime(currEnd, timezone);
      }
      return acc;
    }

    return [...acc, curr];
  }, []);
}
