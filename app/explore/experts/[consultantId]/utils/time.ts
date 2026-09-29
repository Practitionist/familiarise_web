// Helper function to round 59 minutes to next hour
export const roundTime = (timeString: string): string => {
  // Parse time like "4:59 PM" or "11:59 AM"
  const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;
  const match = timeString.match(timeRegex);

  if (!match) return timeString;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();

  // Round 59 minutes to next hour
  if (minutes === 59) {
    hours += 1;

    // Handle hour overflow and AM/PM transition
    if (period === "AM" && hours === 12) {
      return "12:00 PM";
    } else if (period === "PM" && hours === 12) {
      return "12:00 AM";
    } else if (hours > 12) {
      return `${hours - 12}:00 ${period}`;
    } else {
      return `${hours}:00 ${period}`;
    }
  }

  return timeString;
};

// 12-hour "h:MM AM/PM" → minutes since midnight, for sorting picker slots.
// NOT interchangeable with the 24-hour "HH:MM" parsers (`timeToMinutes` in
// utils/dateTimeUtils.ts, `timeStringToMinutes` in slotTimeUtils.ts) — the
// formats are disjoint, which is why this has its own name.
export const timeToMinutes12h = (timeString: string): number => {
  const timeRegex = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;
  const match = timeString.match(timeRegex);

  if (!match) return 0;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();

  // Convert to 24-hour format
  if (period === "AM" && hours === 12) {
    hours = 0;
  } else if (period === "PM" && hours !== 12) {
    hours += 12;
  }

  return hours * 60 + minutes;
};

// Helper function to get local day from date in timezone (equivalent to date-fns-tz)
export const getLocalDay = (date: Date, timezone: string): number => {
  return new Date(
    date.toLocaleString("en-US", { timeZone: timezone }),
  ).getDay();
};
