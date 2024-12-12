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

export function convertUTCToLocalDate(utcTime: string | Date, selectedDate: Date, timezone?: string | null): Date {
  // Parse the UTC time from 1970-01-01 format
  const utcDate = typeof utcTime === 'string' ? new Date(utcTime) : utcTime;
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

  if (timezone) {
    try {
      // Convert UTC to local time string in the user's timezone
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

      return new Date(year, month - 1, day, hours, minutes, seconds);
    } catch (e) {
      console.warn('Invalid timezone, using UTC');
      return utcDateTime;
    }
  }

  return utcDateTime;
}

export function formatTime(date: string | Date, timezone?: string | null): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
      ...(timezone ? { timeZone: timezone } : {})
    }).format(dateObj);
  } catch (e) {
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

export function getLocalDay(date: Date, timezone?: string | null): number {
  if (timezone) {
    try {
      const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
      return localDate.getDay();
    } catch (e) {
      console.warn('Invalid timezone, using UTC');
    }
  }
  return date.getDay();
}

export function isSameLocalDay(date1: Date, date2: Date, timezone?: string | null): boolean {
  if (!timezone) return false;
  
  try {
    const d1 = new Date(date1.toLocaleString('en-US', { timeZone: timezone }));
    const d2 = new Date(date2.toLocaleString('en-US', { timeZone: timezone }));
    
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  } catch (e) {
    console.warn('Invalid timezone');
    return false;
  }
}

export function createWeeklySlot(
  slot: TWeeklySlot,
  selectedDate: Date,
  startDateTime: Date,
  endDateTime: Date,
  timezone?: string | null
): TSlotTiming {
  return {
    slotId: slot.id,
    dateInISO: selectedDate.toISOString(),
    dayOfWeek: slot.dayOfWeekforStartTimeInUTC,
    slotStartTimeInUTC: startDateTime.toISOString(),
    slotEndTimeInUTC: endDateTime.toISOString(),
    slotOfAvailabilityId: slot.id,
    slotOfAppointmentId: "",
    localStartTime: formatTime(startDateTime, timezone),
    localEndTime: formatTime(endDateTime, timezone),
  };
}

export function createCustomSlot(
  slot: TCustomSlot,
  selectedDate: Date,
  startDateTime: Date,
  endDateTime: Date,
  timezone?: string | null
): TSlotTiming {
  return {
    slotId: slot.id,
    dateInISO: selectedDate.toISOString(),
    dayOfWeek: dayMap[startDateTime.getDay()],
    slotStartTimeInUTC: startDateTime.toISOString(),
    slotEndTimeInUTC: endDateTime.toISOString(),
    slotOfAvailabilityId: slot.id,
    slotOfAppointmentId: "",
    localStartTime: formatTime(startDateTime, timezone),
    localEndTime: formatTime(endDateTime, timezone),
  };
}

export function mergeOverlappingSlots(slots: TSlotTiming[], timezone?: string | null): TSlotTiming[] {
  return slots.reduce((acc: TSlotTiming[], curr) => {
    if (acc.length === 0) return [curr];
    
    const last = acc[acc.length - 1];
    const lastEnd = new Date(last.slotEndTimeInUTC);
    const currStart = new Date(curr.slotStartTimeInUTC);
    const currEnd = new Date(curr.slotEndTimeInUTC);
    
    // If current slot starts before or at the same time as the last slot ends
    if (currStart <= lastEnd) {
      // If current slot ends after the last slot
      if (currEnd > lastEnd) {
        last.slotEndTimeInUTC = curr.slotEndTimeInUTC;
        last.localEndTime = formatTime(currEnd, timezone);
      }
      return acc;
    }
    
    // If slots are less than 1 minute apart, merge them
    const diffInMinutes = (currStart.getTime() - lastEnd.getTime()) / (1000 * 60);
    if (diffInMinutes <= 1) {
      last.slotEndTimeInUTC = curr.slotEndTimeInUTC;
      last.localEndTime = formatTime(currEnd, timezone);
      return acc;
    }
    
    return [...acc, curr];
  }, []);
}
