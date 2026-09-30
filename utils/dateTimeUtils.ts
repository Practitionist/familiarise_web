import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { localTimesCrossMidnight } from "@/utils/schedule/overnight";

export const DAYS_OF_WEEK = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export const convertToUTC = (timeStr: string, dateStr: string): string => {
  try {
    // Handle empty time string
    if (!timeStr) return "";

    // Create a date object in local timezone
    const localDate = new Date(`${dateStr}T${timeStr}`);

    // Check if date is valid
    if (isNaN(localDate.getTime())) {
      return "";
    }

    // Convert to UTC string
    return localDate.toISOString();
  } catch (error) {
    console.error("Error converting to UTC:", error);
    return "";
  }
};

export const convertToLocalTime = (utcStr: string): string => {
  try {
    // Handle empty string
    if (!utcStr) return "";

    const date = new Date(utcStr);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (error) {
    console.error("Error converting to local time:", error);
    return "";
  }
};

export const getLocalDateString = (date: Date): string => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// #503 item 2 — canonical rule lives in utils/schedule/overnight.ts.
export const isOvernight = (startTime: string, endTime: string): boolean =>
  localTimesCrossMidnight(startTime, endTime);

export const formatDayDisplay = (day: DayOfWeek): string => {
  return day.charAt(0) + day.slice(1).toLowerCase();
};

export const getNextDay = (day: DayOfWeek): DayOfWeek => {
  const index = DAYS_OF_WEEK.indexOf(day);
  return DAYS_OF_WEEK[(index + 1) % DAYS_OF_WEEK.length];
};

export const getDaysInMonth = (date: Date): number => {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
};

export const getFirstDayOfMonth = (date: Date): number => {
  return new Date(date.getFullYear(), date.getMonth(), 1).getDay();
};

export const formatTime = (
  utcTimeString: string,
  format: "12h" | "24h" = "12h",
): string => {
  try {
    // Handle empty string
    if (!utcTimeString) return "";

    const date = new Date(utcTimeString);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleTimeString("en-US", {
      hour12: format === "12h",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (error) {
    console.error("Error formatting time:", error);
    return utcTimeString;
  }
};

export const formatDate = (
  utcTimeString: string,
  includeWeekday: boolean = true,
): string => {
  try {
    // Handle empty string
    if (!utcTimeString) return "";

    const date = new Date(utcTimeString);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleDateString("en-US", {
      weekday: includeWeekday ? "long" : undefined,
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch (error) {
    console.error("Error formatting date:", error);
    return utcTimeString;
  }
};

// Timezone-aware utility functions for consistent slot handling
export const convertUtcToTimezone = (
  utcTimeString: string,
  timezone: string = "UTC",
): string => {
  try {
    if (!utcTimeString) return "";

    const date = new Date(utcTimeString);
    if (isNaN(date.getTime())) return "";

    // Use date-fns-tz for consistent timezone conversion
    const zonedDate = toZonedTime(date, timezone);

    // Format as HH:mm
    const hours = zonedDate.getHours().toString().padStart(2, "0");
    const minutes = zonedDate.getMinutes().toString().padStart(2, "0");

    return `${hours}:${minutes}`;
  } catch (error) {
    console.error("Error converting UTC to timezone:", error);
    return "";
  }
};

export const convertTimezoneToUtc = (
  timeStr: string,
  dateStr: string,
  timezone: string = "UTC",
): string => {
  try {
    if (!timeStr || !dateStr) return "";

    // Deliberately NO `timezone === "UTC"` shortcut. The obvious one —
    // `new Date(`${dateStr}T${timeStr}:00`).toISOString()` — is a LOCAL-TIME
    // parse: an ES date-time form carrying no offset is read in the host's own
    // zone, so the one branch that promised an absolute answer was the only
    // branch that depended on the machine. Both availability write paths fall
    // back to the literal "UTC" when no zone resolves (`timezone || "UTC"`), so
    // on a host that is not UTC a consultant's whole week was published shifted
    // by the host's offset — silently, and only on that host.
    //
    // "UTC" is not a mode to detect, it is a zone whose offset is zero, and the
    // general path below already answers it: `fromZonedTime` reinterprets the
    // wall clock in the zone it was given, which for UTC is exactly the
    // conversion the shortcut was reaching for. One path per zone is shorter and
    // makes "UTC" and "Etc/UTC" provably the same instant.
    //
    // An unusable zone still throws into the catch, which turns it into "" —
    // the failed-conversion signal every caller already handles (#1125).
    const localDateTime = `${dateStr}T${timeStr}:00`;
    const zonedDate = new Date(localDateTime);

    if (isNaN(zonedDate.getTime())) return "";

    // Convert from the specified timezone to UTC using date-fns-tz
    // First, treat the time as if it's in the target timezone
    const utcDate = fromZonedTime(zonedDate, timezone);

    return utcDate.toISOString();
  } catch (error) {
    console.error("Error converting timezone to UTC:", error);
    return "";
  }
};

/**
 * The calendar day after a `YYYY-MM-DD` key.
 *
 * UTC fields, deliberately. `new Date("2026-09-20")` is a UTC midnight (the
 * date-only form is defined as UTC), so incrementing a LOCAL field off it
 * returned the same string on every host at or behind UTC — the local day was
 * already the day before — and an overnight end was stamped on its own start's
 * date. Advancing the key as a calendar date leaves no host in it.
 */
const nextDateStr = (dateStr: string): string => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(date.getTime())) return dateStr;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split("T")[0];
};

// Enhanced version that handles overnight slots for weekly schedules
export const convertTimezoneToUtcWithOvernight = (
  timeStr: string,
  dateStr: string,
  timezone: string = "UTC",
  isEndTime: boolean = false,
  startTimeStr?: string,
): string => {
  try {
    if (!timeStr || !dateStr) return "";

    // One zone-agnostic path, for the same reason as `convertTimezoneToUtc`
    // above. This used to fork on `timezone === "UTC"` and BOTH forks carried
    // the same overnight detection, so the fork bought nothing and doubled the
    // ways the answer could drift.
    let workingDate = dateStr;

    // If this is an end time and we have a start time, check for overnight
    if (isEndTime && startTimeStr) {
      const [startHour, startMinute] = startTimeStr.split(":").map(Number);
      const [endHour, endMinute] = timeStr.split(":").map(Number);

      const startMinutes = startHour * 60 + startMinute;
      const endMinutes = endHour * 60 + endMinute;

      // If end time is before start time, it's an overnight slot
      if (endMinutes < startMinutes) {
        workingDate = nextDateStr(dateStr);
      }
    }

    const localDateTime = `${workingDate}T${timeStr}:00`;
    const zonedDate = new Date(localDateTime);

    if (isNaN(zonedDate.getTime())) return "";

    // Convert from the specified timezone to UTC using date-fns-tz
    const utcDate = fromZonedTime(zonedDate, timezone);

    return utcDate.toISOString();
  } catch (error) {
    console.error("Error converting timezone to UTC with overnight:", error);
    return "";
  }
};

export const extractTimeFromUtcSlot = (
  utcTimeString: string,
  timezone: string = "UTC",
): string => {
  try {
    if (!utcTimeString) return "";

    const date = new Date(utcTimeString);
    if (isNaN(date.getTime())) return "";

    // For weekly slots, we want to extract the time pattern regardless of date
    // but respect the timezone for display
    if (timezone === "UTC") {
      // Extract UTC time directly
      return (
        date.getUTCHours().toString().padStart(2, "0") +
        ":" +
        date.getUTCMinutes().toString().padStart(2, "0")
      );
    } else {
      // Convert to target timezone
      return convertUtcToTimezone(utcTimeString, timezone);
    }
  } catch (error) {
    console.error("Error extracting time from UTC slot:", error);
    return "";
  }
};

// Utility function to convert time string to minutes for sorting
export const timeToMinutes = (timeString: string): number => {
  try {
    if (!timeString) return 0;
    const [hours, minutes] = timeString.split(":").map(Number);
    return hours * 60 + minutes;
  } catch (error) {
    console.error("Error converting time to minutes:", error);
    return 0;
  }
};

// Sort slots chronologically by start time
export const sortSlotsByTime = <T extends { startTime: string }>(
  slots: T[],
): T[] => {
  return slots.sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
  );
};
