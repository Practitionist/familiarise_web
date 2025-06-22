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

export const isOvernight = (startTime: string, endTime: string): boolean => {
  // Handle empty strings
  if (!startTime || !endTime) return false;

  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);

  // Check if numbers are valid
  if (
    isNaN(startHour) ||
    isNaN(startMinute) ||
    isNaN(endHour) ||
    isNaN(endMinute)
  ) {
    return false;
  }

  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return endMinutes < startMinutes;
};

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
