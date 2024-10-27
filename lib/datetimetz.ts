import { TSlotTiming } from '@/types/slots';
import { parseISO } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

export function convertZoneTimeToUTC(dateString: string, timeZone: string): string | null {
  try {
    const zonedDate = parseISO(dateString);
    const utcDate = fromZonedTime(zonedDate, timeZone);
    return formatInTimeZone(utcDate, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  } catch (error) {
    console.error('Error converting zone time to UTC:', error);
    return null;
  }
}

export function convertUTCToZoneTime(utcDateString: string, timeZone: string): string | null {
  try {
    const utcDate = parseISO(utcDateString);
    const zonedDate = toZonedTime(utcDate, timeZone);
    return formatInTimeZone(zonedDate, timeZone, "yyyy-MM-dd HH:mm:ss");
  } catch (error) {
    console.error('Error converting UTC to zone time:', error);
    return null;
  }
}

export function convertToUserTimezone(dateString: string, sourceTimeZone: string, userTimeZone: string): string | null {
  try {
    const sourceDate = parseISO(dateString);
    const utcDate = fromZonedTime(sourceDate, sourceTimeZone);
    const userDate = toZonedTime(utcDate, userTimeZone);
    return formatInTimeZone(userDate, userTimeZone, "yyyy-MM-dd HH:mm:ss");
  } catch (error) {
    console.error('Error converting to user timezone:', error);
    return null;
  }
}

export function convertSlotsToUserTimezone(slots: TSlotTiming[], userTimeZone: string): TSlotTiming[] {
  try {
    return slots.map((slot) => ({
      ...slot,
      dateInISO: convertUTCToZoneTime(slot.dateInISO, userTimeZone) || slot.dateInISO,
      localStartTime: convertUTCToZoneTime(slot.slotStartTimeInUTC, userTimeZone) || slot.localStartTime,
      localEndTime: convertUTCToZoneTime(slot.slotEndTimeInUTC, userTimeZone) || slot.localEndTime,
    }));
  } catch (error) {
    console.error('Error converting slots to user timezone:', error);
    return slots; // Return original slots if conversion fails
  }
}