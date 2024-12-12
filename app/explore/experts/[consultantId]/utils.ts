import { DayOfWeek } from "@prisma/client";
import { TWeeklySlot, TCustomSlot, TSlotTiming } from "@/types/slots";

export const dayMap: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY
};

export const dayToNumber: Record<DayOfWeek, number> = {
  [DayOfWeek.SUNDAY]: 0,
  [DayOfWeek.MONDAY]: 1,
  [DayOfWeek.TUESDAY]: 2,
  [DayOfWeek.WEDNESDAY]: 3,
  [DayOfWeek.THURSDAY]: 4,
  [DayOfWeek.FRIDAY]: 5,
  [DayOfWeek.SATURDAY]: 6
};

// Ensure UTC time is always a string
export function normalizeUTCTime(time: string | Date): string {
  return typeof time === 'string' ? time : time.toISOString();
}

// Normalize weekly slot to ensure all times are strings
export function normalizeWeeklySlot(slot: TWeeklySlot): TWeeklySlot & { 
  slotStartTimeInUTC: string; 
  slotEndTimeInUTC: string; 
} {
  return {
    ...slot,
    slotStartTimeInUTC: normalizeUTCTime(slot.slotStartTimeInUTC),
    slotEndTimeInUTC: normalizeUTCTime(slot.slotEndTimeInUTC)
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
    slotEndTimeInUTC: normalizeUTCTime(slot.slotEndTimeInUTC)
  };
}

export function getLocalDay(date: Date, timezone?: string | null): number {
  if (!timezone) return date.getDay();

  try {
    const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    console.log('Local day calculation:', {
      originalDate: date.toISOString(),
      timezone,
      localDate: localDate.toISOString(),
      localDay: localDate.getDay()
    });
    return localDate.getDay();
  } catch (e) {
    console.warn('Invalid timezone, using UTC day');
    return date.getUTCDay();
  }
}

export function convertUTCToLocalDate(utcTime: string, selectedDate: Date, timezone?: string | null): Date {
  // Parse the UTC time from 1970-01-01 format
  const utcDate = new Date(utcTime);
  const utcHours = utcDate.getUTCHours();
  const utcMinutes = utcDate.getUTCMinutes();

  // Create a new date in UTC
  const utcDateTime = new Date(Date.UTC(
    selectedDate.getFullYear(),
    selectedDate.getMonth(),
    selectedDate.getDate(),
    utcHours,
    utcMinutes,
    0,
    0
  ));

  if (!timezone) return utcDateTime;

  try {
    // Convert UTC to local time string in the target timezone
    const localTimeStr = utcDateTime.toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });

    // Parse the local time string back to a Date object
    const [datePart, timePart] = localTimeStr.split(', ');
    const [month, day, year] = datePart.split('/').map(Number);
    const [hours, minutes, seconds] = timePart.split(':').map(Number);

    const localDate = new Date(year, month - 1, day, hours, minutes, seconds);
    
    // Adjust date if the local time is on a different day
    const localDay = getLocalDay(localDate, timezone);
    const selectedDay = getLocalDay(selectedDate, timezone);
    
    if (localDay !== selectedDay) {
      // Handle week wrap-around
      if (selectedDay === 0 && localDay === 6) {
        // If selected day is Sunday and local day is Saturday, add a day
        localDate.setDate(localDate.getDate() + 1);
      } else if (selectedDay === 6 && localDay === 0) {
        // If selected day is Saturday and local day is Sunday, subtract a day
        localDate.setDate(localDate.getDate() - 1);
      } else if (localDay === selectedDay - 1) {
        // If local day is the previous day, add a day
        localDate.setDate(localDate.getDate() + 1);
      } else if (localDay === selectedDay + 1) {
        // If local day is the next day, subtract a day
        localDate.setDate(localDate.getDate() - 1);
      }
    }

    console.log('UTC to Local conversion:', {
      utcTime: utcDateTime.toISOString(),
      timezone,
      localTime: localDate.toISOString()
    });

    return localDate;
  } catch (e) {
    console.warn('Invalid timezone, using UTC');
    return utcDateTime;
  }
}

export function formatTime(date: string | Date, timezone?: string | null): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      timeZone: timezone || undefined
    }).format(dateObj);
  } catch (e) {
    console.warn('Error formatting time:', e);
    return dateObj.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true
    });
  }
}

export function getDayBefore(day: DayOfWeek): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY
  ];
  const index = days.indexOf(day);
  return days[(index - 1 + 7) % 7];
}

export function getDayAfter(day: DayOfWeek): DayOfWeek {
  const days = [
    DayOfWeek.SUNDAY,
    DayOfWeek.MONDAY,
    DayOfWeek.TUESDAY,
    DayOfWeek.WEDNESDAY,
    DayOfWeek.THURSDAY,
    DayOfWeek.FRIDAY,
    DayOfWeek.SATURDAY
  ];
  const index = days.indexOf(day);
  return days[(index + 1) % 7];
}

export function isSameLocalDay(date1: Date, date2: Date, timezone?: string | null): boolean {
  if (!timezone) return false;

  try {
    const d1 = new Date(date1.toLocaleString('en-US', { timeZone: timezone }));
    const d2 = new Date(date2.toLocaleString('en-US', { timeZone: timezone }));
    
    const result = d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();

    console.log('Same local day check:', {
      date1: date1.toISOString(),
      date2: date2.toISOString(),
      timezone,
      localDate1: d1.toISOString(),
      localDate2: d2.toISOString(),
      isSameDay: result
    });

    return result;
  } catch (e) {
    console.warn('Invalid timezone');
    return false;
  }
}

export function isSlotRelevantForDay(
  slot: TWeeklySlot,
  selectedDay: DayOfWeek,
  timezone?: string | null
): boolean {
  const startDay = slot.dayOfWeekforStartTimeInUTC;
  const endDay = slot.dayOfWeekforEndTimeInUTC;
  
  // Direct match
  if (startDay === selectedDay) return true;

  // Handle overnight slots
  if (startDay !== endDay) {
    const selectedDayNum = dayToNumber[selectedDay];
    const startDayNum = dayToNumber[startDay];
    const endDayNum = dayToNumber[endDay];

    // Handle week wrap-around (e.g., Saturday to Sunday)
    if (startDayNum > endDayNum) {
      // For slots that wrap around the week (e.g., Sat 9pm - Sun 3am)
      // The slot is relevant for both the start day and the end day
      if (selectedDay === endDay) return true;
      
      // For days in between (in case of multi-day slots)
      const dayAfterStart = (startDayNum + 1) % 7;
      return selectedDayNum >= startDayNum || selectedDayNum <= endDayNum ||
             (selectedDayNum >= dayAfterStart && selectedDayNum <= 6);
    }

    // Normal case (e.g., Mon 10pm - Tue 2am)
    return selectedDayNum >= startDayNum && selectedDayNum <= endDayNum;
  }

  return false;
}

export function createWeeklySlot(
  slot: TWeeklySlot,
  selectedDate: Date,
  startDateTime: Date,
  endDateTime: Date,
  timezone?: string | null
): TSlotTiming {
  let adjustedEndDateTime = new Date(endDateTime);
  const normalizedSlot = normalizeWeeklySlot(slot);

  // Handle slots that cross midnight
  if (slot.dayOfWeekforStartTimeInUTC !== slot.dayOfWeekforEndTimeInUTC ||
      endDateTime <= startDateTime ||
      (endDateTime.getHours() === 0 && endDateTime.getMinutes() === 0)) {
    
    adjustedEndDateTime = new Date(endDateTime);
    adjustedEndDateTime.setDate(adjustedEndDateTime.getDate() + 1);
  }

  const slotTiming = {
    slotId: normalizedSlot.id,
    dateInISO: selectedDate.toISOString(),
    dayOfWeek: normalizedSlot.dayOfWeekforStartTimeInUTC,
    slotStartTimeInUTC: startDateTime.toISOString(),
    slotEndTimeInUTC: adjustedEndDateTime.toISOString(),
    slotOfAvailabilityId: normalizedSlot.id,
    slotOfAppointmentId: "",
    localStartTime: formatTime(startDateTime, timezone),
    localEndTime: formatTime(adjustedEndDateTime, timezone),
  };

  console.log('Created weekly slot:', {
    startDay: normalizedSlot.dayOfWeekforStartTimeInUTC,
    endDay: normalizedSlot.dayOfWeekforEndTimeInUTC,
    utcStart: normalizedSlot.slotStartTimeInUTC,
    utcEnd: normalizedSlot.slotEndTimeInUTC,
    localStart: slotTiming.localStartTime,
    localEnd: slotTiming.localEndTime,
    timezone,
    crossesMidnight: normalizedSlot.dayOfWeekforStartTimeInUTC !== normalizedSlot.dayOfWeekforEndTimeInUTC
  });

  return slotTiming;
}

export function createCustomSlot(
  slot: TCustomSlot,
  selectedDate: Date,
  startDateTime: Date,
  endDateTime: Date,
  timezone?: string | null
): TSlotTiming {
  let adjustedEndDateTime = new Date(endDateTime);
  const normalizedSlot = normalizeCustomSlot(slot);

  // Handle slots that cross midnight
  if (endDateTime <= startDateTime ||
      (endDateTime.getHours() === 0 && endDateTime.getMinutes() === 0)) {
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

  console.log('Created custom slot:', {
    utcStart: normalizedSlot.slotStartTimeInUTC,
    utcEnd: normalizedSlot.slotEndTimeInUTC,
    localStart: slotTiming.localStartTime,
    localEnd: slotTiming.localEndTime,
    timezone,
    crossesMidnight: adjustedEndDateTime.getDate() > startDateTime.getDate()
  });

  return slotTiming;
}

export function mergeOverlappingSlots(slots: TSlotTiming[], timezone?: string | null): TSlotTiming[] {
  // Don't merge slots that are more than 1 minute apart
  return slots.reduce((acc: TSlotTiming[], curr) => {
    if (acc.length === 0) return [curr];
    
    const last = acc[acc.length - 1];
    const lastEnd = new Date(last.slotEndTimeInUTC);
    const currStart = new Date(curr.slotStartTimeInUTC);
    const currEnd = new Date(curr.slotEndTimeInUTC);
    
    // Only merge if the slots are exactly adjacent (less than 1 minute apart)
    const diffInMinutes = (currStart.getTime() - lastEnd.getTime()) / (1000 * 60);
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
