import { DayOfWeek } from "@prisma/client";
import { addDays, endOfDay, isBefore, startOfDay } from "date-fns";
import { format, toZonedTime, fromZonedTime } from "date-fns-tz";
import { TSlotTiming } from "@/types/slots";

// Helper mappings
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
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export interface WeeklySlot {
  id: string;
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: Date;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotEndTimeInUTC: Date;
}

export interface CustomSlot {
  id: string;
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
}

export interface AppointmentSlot {
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
}

export interface ProcessedSlot {
  start: Date;
  end: Date;
  availabilityId: string;
  type: "WEEKLY" | "CUSTOM";
}

/**
 * Checks if two time ranges overlap with support for partial, full, and eclipsing overlaps
 */
export function hasTimeOverlap(
  start1: Date,
  end1: Date,
  start2: Date,
  end2: Date
): boolean {
  return start1 < end2 && start2 < end1;
}

/**
 * Process weekly slots for a specific date range
 */
export function processWeeklySlots(
  weeklySlots: WeeklySlot[],
  startDate: Date,
  endDate: Date,
  timezone: string
): ProcessedSlot[] {
  const processedSlots: ProcessedSlot[] = [];
  
  // Convert start and end dates to target timezone
  const startDateTz = toZonedTime(startDate, timezone);
  const endDateTz = toZonedTime(endDate, timezone);
  let currentDateTz = startOfDay(startDateTz);

  while (isBefore(currentDateTz, endDateTz)) {
    const currentDayOfWeek = currentDateTz.getDay();
    const dayOfWeekEnum = dayMap[currentDayOfWeek];

    weeklySlots.forEach((slot) => {
      if (slot.dayOfWeekforStartTimeInUTC === dayOfWeekEnum) {
        const startTime = slot.slotStartTimeInUTC;
        const endTime = slot.slotEndTimeInUTC;

        const startDateTime = new Date(currentDateTz);
        startDateTime.setHours(
          startTime.getUTCHours(),
          startTime.getUTCMinutes(),
          startTime.getUTCSeconds(),
          startTime.getUTCMilliseconds()
        );

        // Calculate end day offset for handling overnight slots
        let endDayOffset = (
          dayToNumber[slot.dayOfWeekforEndTimeInUTC] - 
          dayToNumber[slot.dayOfWeekforStartTimeInUTC] + 7
        ) % 7;
        
        if (endTime <= startTime) {
          endDayOffset = (endDayOffset + 1) % 7;
          if (endDayOffset === 0) endDayOffset = 1;
        }
        
        const endDateTime = new Date(startDateTime);
        if (endDayOffset > 0) {
          endDateTime.setDate(startDateTime.getDate() + endDayOffset);
        }
        endDateTime.setHours(
          endTime.getUTCHours(),
          endTime.getUTCMinutes(),
          endTime.getUTCSeconds(),
          endTime.getUTCMilliseconds()
        );

        // If end time is still before start time, push end date by one day
        if (endDateTime <= startDateTime) {
          endDateTime.setDate(endDateTime.getDate() + 1);
        }

        const startUTC = fromZonedTime(startDateTime, timezone);
        const endUTC = fromZonedTime(endDateTime, timezone);

        processedSlots.push({
          start: startUTC,
          end: endUTC,
          availabilityId: slot.id,
          type: "WEEKLY",
        });
      }
    });

    currentDateTz = addDays(currentDateTz, 1);
  }

  return processedSlots;
}

/**
 * Process custom slots for a specific date range
 */
export function processCustomSlots(
  customSlots: CustomSlot[],
  startDate: Date,
  endDate: Date
): ProcessedSlot[] {
  return customSlots
    .filter((slot) => {
      // Only include slots that overlap with our date range
      return hasTimeOverlap(slot.slotStartTimeInUTC, slot.slotEndTimeInUTC, startDate, endDate);
    })
    .map((slot) => ({
      start: slot.slotStartTimeInUTC,
      end: slot.slotEndTimeInUTC,
      availabilityId: slot.id,
      type: "CUSTOM" as const,
    }));
}

/**
 * Split slots that cross midnight in the target timezone
 */
export function splitSlotsByDay(
  slots: ProcessedSlot[],
  timezone: string
): ProcessedSlot[] {
  const splitSlots: ProcessedSlot[] = [];

  slots.forEach((slot) => {
    let current = slot.start;
    
    while (isBefore(current, slot.end)) {
      const zonedCurrent = toZonedTime(current, timezone);
      const dayStart = startOfDay(zonedCurrent);
      const dayEnd = endOfDay(zonedCurrent);

      const slotPartEnd = isBefore(slot.end, fromZonedTime(dayEnd, timezone))
        ? slot.end
        : fromZonedTime(dayEnd, timezone);

      splitSlots.push({
        start: current,
        end: slotPartEnd,
        availabilityId: slot.availabilityId,
        type: slot.type,
      });

      const nextDayStart = fromZonedTime(addDays(dayStart, 1), timezone);
      if (isBefore(nextDayStart, current) || nextDayStart.getTime() === current.getTime()) {
        break;
      }
      current = nextDayStart;
    }
  });

  return splitSlots;
}

/**
 * Check if a slot is allocated by comparing with appointment slots
 */
export function isSlotAllocated(
  slotStart: Date,
  slotEnd: Date,
  appointmentSlots: AppointmentSlot[]
): boolean {
  return appointmentSlots.some((apptSlot) =>
    hasTimeOverlap(slotStart, slotEnd, apptSlot.slotStartTimeInUTC, apptSlot.slotEndTimeInUTC)
  );
}

/**
 * Convert processed slots to TSlotTiming format
 */
export function convertToSlotTimings(
  processedSlots: ProcessedSlot[],
  appointmentSlots: AppointmentSlot[],
  timezone: string
): (TSlotTiming & { isAllocated: boolean })[] {
  const slotTimings = processedSlots.map((slot) => {
    const isAllocated = isSlotAllocated(slot.start, slot.end, appointmentSlots);
    const zonedStart = toZonedTime(slot.start, timezone);
    
    return {
      slotId: `${slot.availabilityId}-${slot.start.toISOString()}`,
      dateInISO: slot.start.toISOString(),
      dayOfWeek: dayMap[zonedStart.getDay()],
      slotStartTimeInUTC: slot.start.toISOString(),
      slotEndTimeInUTC: slot.end.toISOString(),
      slotOfAvailabilityId: slot.availabilityId,
      slotOfAppointmentId: "",
      localStartTime: format(slot.start, "p", { timeZone: timezone }),
      localEndTime: format(slot.end, "p", { timeZone: timezone }),
      type: slot.type,
      isAllocated,
    } as TSlotTiming & { isAllocated: boolean };
  });

  // Sort chronologically by start time
  slotTimings.sort((a, b) => 
    new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
  );

  return slotTimings;
}

/**
 * Break down slots by duration while preserving allocation information
 */
export function breakDownSlotsByDuration(
  slots: (TSlotTiming & { isAllocated: boolean })[],
  durationInHours: number,
  appointmentSlots: AppointmentSlot[],
  timezone: string
): (TSlotTiming & { isAllocated: boolean })[] {
  const brokenDownSlots: (TSlotTiming & { isAllocated: boolean })[] = [];
  
  if (!slots || slots.length === 0) return brokenDownSlots;

  slots.forEach((slot) => {
    const start = new Date(slot.slotStartTimeInUTC);
    const end = new Date(slot.slotEndTimeInUTC);
    const durationInMillis = durationInHours * 60 * 60 * 1000;

    let currentStart = start;
    while (currentStart.getTime() + durationInMillis <= end.getTime()) {
      const currentEnd = new Date(currentStart.getTime() + durationInMillis);
      
      // Check if this specific segment is allocated
      const isSegmentAllocated = isSlotAllocated(currentStart, currentEnd, appointmentSlots);
      
      brokenDownSlots.push({
        ...slot,
        slotId: `${slot.slotOfAvailabilityId}-${currentStart.getTime()}`,
        slotStartTimeInUTC: currentStart.toISOString(),
        slotEndTimeInUTC: currentEnd.toISOString(),
        localStartTime: format(currentStart, "p", { timeZone: timezone }),
        localEndTime: format(currentEnd, "p", { timeZone: timezone }),
        isAllocated: isSegmentAllocated,
      });
      
      currentStart = currentEnd;
    }
  });

  // Sort chronologically
  brokenDownSlots.sort((a, b) => 
    new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
  );

  return brokenDownSlots;
}

/**
 * Group slots by date in the target timezone
 */
export function groupSlotsByDate(
  slotTimings: (TSlotTiming & { isAllocated: boolean })[],
  timezone: string
): Record<string, (TSlotTiming & { isAllocated: boolean })[]> {
  const slotsByDate = slotTimings.reduce(
    (acc, slot) => {
      const dateKey = format(
        toZonedTime(new Date(slot.slotStartTimeInUTC), timezone),
        "yyyy-MM-dd"
      );
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(slot);
      return acc;
    },
    {} as Record<string, (TSlotTiming & { isAllocated: boolean })[]>
  );

  // Sort slots within each day chronologically
  Object.keys(slotsByDate).forEach((dateKey) => {
    slotsByDate[dateKey].sort((a, b) => 
      new Date(a.slotStartTimeInUTC).getTime() - new Date(b.slotStartTimeInUTC).getTime()
    );
  });

  return slotsByDate;
}

/**
 * Main function to process all availability slots with allocation detection
 */
export function processAvailabilitySlots(
  weeklySlots: WeeklySlot[],
  customSlots: CustomSlot[],
  appointmentSlots: AppointmentSlot[],
  startDate: Date,
  endDate: Date,
  timezone: string
): Record<string, (TSlotTiming & { isAllocated: boolean })[]> {
  // Process weekly and custom slots
  const processedWeeklySlots = processWeeklySlots(weeklySlots, startDate, endDate, timezone);
  const processedCustomSlots = processCustomSlots(customSlots, startDate, endDate);
  
  // Combine all slots
  const allSlots = [...processedWeeklySlots, ...processedCustomSlots];
  
  // Split slots that cross midnight
  const splitSlots = splitSlotsByDay(allSlots, timezone);
  
  // Convert to slot timings with allocation detection
  const slotTimings = convertToSlotTimings(splitSlots, appointmentSlots, timezone);
  
  // Group by date
  return groupSlotsByDate(slotTimings, timezone);
} 