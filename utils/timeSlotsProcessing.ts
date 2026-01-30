import { DayOfWeek } from "@prisma/client";
import { addDays, endOfDay, isBefore, startOfDay } from "date-fns";
import { format, toZonedTime, fromZonedTime } from "date-fns-tz";
import { TSlotTiming } from "@/types/slots";

// Booking status constants and types
export const BOOKING_STATUS = {
  AVAILABLE: "available",
  PARTIALLY_BOOKED: "partially-booked",
  FULLY_BOOKED: "fully-booked",
} as const;

export type BookingStatus =
  (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

// Booking threshold constant
export const FULLY_BOOKED_THRESHOLD = 0.99;

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
  type: "WEEKLY" | "CUSTOM"; // Keep as is to match TSlotTiming
}

/**
 * Checks if two time ranges overlap with support for partial, full, and eclipsing overlaps
 */
export function hasTimeOverlap(
  start1: Date,
  end1: Date,
  start2: Date,
  end2: Date,
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
  timezone: string,
): ProcessedSlot[] {
  const processedSlots: ProcessedSlot[] = [];

  // Defensive: Validate input parameters
  if (!Array.isArray(weeklySlots)) {
    console.warn("⚠️ processWeeklySlots: weeklySlots is not an array");
    return processedSlots;
  }

  if (
    !startDate ||
    !endDate ||
    isNaN(startDate.getTime()) ||
    isNaN(endDate.getTime())
  ) {
    console.warn("⚠️ processWeeklySlots: invalid startDate or endDate");
    return processedSlots;
  }

  if (endDate <= startDate) {
    console.warn("⚠️ processWeeklySlots: endDate must be after startDate");
    return processedSlots;
  }

  // Convert start and end dates to target timezone
  const startDateTz = toZonedTime(startDate, timezone);
  const endDateTz = toZonedTime(endDate, timezone);
  let currentDateTz = startOfDay(startDateTz);

  while (isBefore(currentDateTz, endDateTz)) {
    const currentDayOfWeek = currentDateTz.getDay();
    const dayOfWeekEnum = dayMap[currentDayOfWeek];

    weeklySlots.forEach((slot) => {
      // Defensive: Skip slots with invalid data
      if (
        !slot ||
        !slot.id ||
        !slot.slotStartTimeInUTC ||
        !slot.slotEndTimeInUTC
      ) {
        console.warn(
          `⚠️ processWeeklySlots: skipping slot with missing required fields`,
        );
        return;
      }
      if (slot.dayOfWeekforStartTimeInUTC === dayOfWeekEnum) {
        // Extract LOCAL time patterns from the stored weekly slot
        // Convert the stored UTC times to the target timezone to get the local time pattern
        const startTimeLocal = toZonedTime(slot.slotStartTimeInUTC, timezone);
        const endTimeLocal = toZonedTime(slot.slotEndTimeInUTC, timezone);

        const startHour = startTimeLocal.getHours();
        const startMinute = startTimeLocal.getMinutes();
        const endHour = endTimeLocal.getHours();
        const endMinute = endTimeLocal.getMinutes();

        // Create start time for this specific occurrence in the target timezone
        const startDateTime = new Date(currentDateTz);
        startDateTime.setHours(startHour, startMinute, 0, 0);

        // Create end time for this specific occurrence
        const endDateTime = new Date(currentDateTz);
        endDateTime.setHours(endHour, endMinute, 0, 0);

        // Handle overnight slots: if end hour < start hour, the slot crosses midnight
        if (
          endHour < startHour ||
          (endHour === startHour && endMinute < startMinute)
        ) {
          endDateTime.setDate(endDateTime.getDate() + 1);
        }

        // Convert the timezone-aware datetimes to UTC for storage/API response
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
  endDate: Date,
): ProcessedSlot[] {
  // Defensive: Validate input parameters
  if (!Array.isArray(customSlots)) {
    console.warn("⚠️ processCustomSlots: customSlots is not an array");
    return [];
  }

  if (
    !startDate ||
    !endDate ||
    isNaN(startDate.getTime()) ||
    isNaN(endDate.getTime())
  ) {
    console.warn("⚠️ processCustomSlots: invalid startDate or endDate");
    return [];
  }

  if (endDate <= startDate) {
    console.warn("⚠️ processCustomSlots: endDate must be after startDate");
    return [];
  }

  return customSlots
    .filter((slot) => {
      // Defensive: Skip slots with invalid data
      if (
        !slot ||
        !slot.id ||
        !slot.slotStartTimeInUTC ||
        !slot.slotEndTimeInUTC
      ) {
        console.warn(
          `⚠️ processCustomSlots: skipping slot with missing required fields`,
        );
        return false;
      }

      // Defensive: Validate dates are valid
      const start = new Date(slot.slotStartTimeInUTC);
      const end = new Date(slot.slotEndTimeInUTC);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        console.warn(
          `⚠️ processCustomSlots: skipping slot ${slot.id} with invalid date format`,
        );
        return false;
      }

      // Defensive: Check slot is not inverted (end <= start, not overnight)
      if (end <= start) {
        console.warn(
          `⚠️ processCustomSlots: skipping slot ${slot.id} with end <= start`,
        );
        return false;
      }

      // Only include slots that overlap with our date range
      return hasTimeOverlap(
        slot.slotStartTimeInUTC,
        slot.slotEndTimeInUTC,
        startDate,
        endDate,
      );
    })
    .map((slot) => ({
      start: slot.slotStartTimeInUTC,
      end: slot.slotEndTimeInUTC,
      availabilityId: slot.id,
      type: "CUSTOM",
    }));
}

/**
 * Split slots that cross midnight in the target timezone
 */
export function splitSlotsByDay(
  slots: ProcessedSlot[],
  timezone: string,
): ProcessedSlot[] {
  const splitSlots: ProcessedSlot[] = [];

  slots.forEach((slot) => {
    let current = slot.start;

    while (isBefore(current, slot.end)) {
      const zonedCurrent = toZonedTime(current, timezone);
      const dayStart = startOfDay(zonedCurrent);
      const dayEnd = endOfDay(zonedCurrent);

      const slotPartEndCandidate = isBefore(
        slot.end,
        fromZonedTime(dayEnd, timezone),
      )
        ? slot.end
        : fromZonedTime(dayEnd, timezone);

      // Skip zero-length segments
      if (slotPartEndCandidate.getTime() === current.getTime()) {
        break;
      }

      const slotPartEnd = slotPartEndCandidate;

      // Push valid segment
      if (isBefore(current, slotPartEnd)) {
        splitSlots.push({
          start: current,
          end: slotPartEnd,
          availabilityId: slot.availabilityId,
          type: slot.type,
        });
      }

      const nextDayStart = fromZonedTime(addDays(dayStart, 1), timezone);
      if (
        isBefore(nextDayStart, current) ||
        nextDayStart.getTime() === current.getTime()
      ) {
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
  appointmentSlots: AppointmentSlot[],
): boolean {
  return appointmentSlots.some((apptSlot) =>
    hasTimeOverlap(
      slotStart,
      slotEnd,
      apptSlot.slotStartTimeInUTC,
      apptSlot.slotEndTimeInUTC,
    ),
  );
}

/**
 * Calculate the booking status of a slot (available, partially booked, or fully booked)
 */
export function getSlotBookingStatus(
  slotStart: Date,
  slotEnd: Date,
  appointmentSlots: AppointmentSlot[],
): BookingStatus {
  // Defensive: Validate input parameters
  if (
    !slotStart ||
    !slotEnd ||
    isNaN(slotStart.getTime()) ||
    isNaN(slotEnd.getTime())
  ) {
    console.warn("⚠️ getSlotBookingStatus: invalid slotStart or slotEnd");
    return BOOKING_STATUS.AVAILABLE;
  }

  if (slotEnd <= slotStart) {
    console.warn("⚠️ getSlotBookingStatus: slotEnd must be after slotStart");
    return BOOKING_STATUS.AVAILABLE;
  }

  if (!Array.isArray(appointmentSlots)) {
    console.warn("⚠️ getSlotBookingStatus: appointmentSlots is not an array");
    return BOOKING_STATUS.AVAILABLE;
  }

  const slotDuration = slotEnd.getTime() - slotStart.getTime();

  // Find all appointments that overlap with this slot (with defensive filtering)
  const overlappingAppointments = appointmentSlots.filter((apptSlot) => {
    // Defensive: Skip invalid appointment slots
    if (
      !apptSlot ||
      !apptSlot.slotStartTimeInUTC ||
      !apptSlot.slotEndTimeInUTC
    ) {
      return false;
    }

    const start = new Date(apptSlot.slotStartTimeInUTC);
    const end = new Date(apptSlot.slotEndTimeInUTC);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return false;
    }

    return hasTimeOverlap(
      slotStart,
      slotEnd,
      apptSlot.slotStartTimeInUTC,
      apptSlot.slotEndTimeInUTC,
    );
  });

  if (overlappingAppointments.length === 0) {
    return BOOKING_STATUS.AVAILABLE;
  }

  // Calculate total covered duration by merging overlapping appointments
  const intervals = overlappingAppointments.map((appt) => ({
    start: Math.max(slotStart.getTime(), appt.slotStartTimeInUTC.getTime()),
    end: Math.min(slotEnd.getTime(), appt.slotEndTimeInUTC.getTime()),
  }));

  // Sort intervals by start time
  intervals.sort((a, b) => a.start - b.start);

  // Merge overlapping intervals and calculate total coverage
  let totalCovered = 0;
  let currentEnd = 0;

  for (const interval of intervals) {
    if (interval.start > currentEnd) {
      // Non-overlapping interval
      totalCovered += interval.end - interval.start;
      currentEnd = interval.end;
    } else if (interval.end > currentEnd) {
      // Overlapping interval, extend the current coverage
      totalCovered += interval.end - currentEnd;
      currentEnd = interval.end;
    }
    // If interval.end <= currentEnd, it's completely covered, so no additional coverage
  }

  // Determine booking status based on coverage percentage
  const coveragePercentage = totalCovered / slotDuration;

  if (coveragePercentage >= FULLY_BOOKED_THRESHOLD) {
    // Allow for small rounding errors
    return BOOKING_STATUS.FULLY_BOOKED;
  } else if (coveragePercentage > 0) {
    return BOOKING_STATUS.PARTIALLY_BOOKED;
  } else {
    return BOOKING_STATUS.AVAILABLE;
  }
}

/**
 * Convert processed slots to TSlotTiming format
 */
export function convertToSlotTimings(
  processedSlots: ProcessedSlot[],
  appointmentSlots: AppointmentSlot[],
  timezone: string,
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
})[] {
  const slotTimings = processedSlots.map((slot) => {
    const isAllocated = isSlotAllocated(slot.start, slot.end, appointmentSlots);
    const bookingStatus = getSlotBookingStatus(
      slot.start,
      slot.end,
      appointmentSlots,
    );
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
      type: slot.type, // Explicitly set the type field
      isAllocated,
      bookingStatus,
    } as TSlotTiming & {
      isAllocated: boolean;
      bookingStatus: BookingStatus;
    };
  });

  // Sort chronologically by start time
  slotTimings.sort(
    (a, b) =>
      new Date(a.slotStartTimeInUTC).getTime() -
      new Date(b.slotStartTimeInUTC).getTime(),
  );

  return slotTimings;
}

/**
 * Merge consecutive availability slots into contiguous blocks.
 * This allows longer durations to be scheduled across multiple adjacent slots.
 * 
 * For example, if slots are 2:30-3:00 and 3:00-3:30, this will merge them into 2:30-3:30.
 * Only merges slots that are NOT allocated (available).
 */
export function mergeConsecutiveSlots(
  slots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
  })[]
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus?: BookingStatus;
})[] {
  if (!slots || slots.length === 0) return [];

  // Sort slots by start time
  const sortedSlots = [...slots].sort(
    (a, b) =>
      new Date(a.slotStartTimeInUTC).getTime() -
      new Date(b.slotStartTimeInUTC).getTime()
  );

  const mergedSlots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
  })[] = [];

  let currentMerged = { ...sortedSlots[0] };

  for (let i = 1; i < sortedSlots.length; i++) {
    const currentSlot = sortedSlots[i];
    const currentMergedEnd = new Date(currentMerged.slotEndTimeInUTC).getTime();
    const nextSlotStart = new Date(currentSlot.slotStartTimeInUTC).getTime();

    // Check if slots are consecutive (end time equals start time) and both are available
    // Allow a small tolerance of 1 minute for edge cases
    const isConsecutive = Math.abs(currentMergedEnd - nextSlotStart) <= 60000;
    const bothAvailable = !currentMerged.isAllocated && !currentSlot.isAllocated;

    if (isConsecutive && bothAvailable) {
      // Extend the current merged slot
      currentMerged = {
        ...currentMerged,
        slotEndTimeInUTC: currentSlot.slotEndTimeInUTC,
        localEndTime: currentSlot.localEndTime,
      };
    } else {
      // Push the current merged slot and start a new one
      mergedSlots.push(currentMerged);
      currentMerged = { ...currentSlot };
    }
  }

  // Don't forget the last slot
  mergedSlots.push(currentMerged);

  return mergedSlots;
}

/**
 * Break down slots by duration using sliding windows while preserving allocation information
 */
export function breakDownSlotsByDuration(
  slots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
  })[],
  durationInHours: number,
  appointmentSlots: AppointmentSlot[],
  timezone: string,
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
})[] {
  const brokenDownSlots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[] = [];

  if (!slots || slots.length === 0) return brokenDownSlots;

  // Define sliding window interval (30 minutes)
  const slidingIntervalMinutes = 30;
  const slidingIntervalMillis = slidingIntervalMinutes * 60 * 1000;
  const durationInMillis = durationInHours * 60 * 60 * 1000;

  slots.forEach((slot) => {
    const start = new Date(slot.slotStartTimeInUTC);
    const end = new Date(slot.slotEndTimeInUTC);

    // Generate sliding windows
    let currentStart = start;
    while (currentStart.getTime() + durationInMillis <= end.getTime()) {
      const currentEnd = new Date(currentStart.getTime() + durationInMillis);

      // FIX: Check ONLY this specific segment's overlap with appointments
      // Previously, this inherited slot.isAllocated from the parent slot,
      // which caused ALL segments to be marked allocated if ANY part of the
      // original availability slot overlapped with an appointment
      const isSegmentAllocated = isSlotAllocated(currentStart, currentEnd, appointmentSlots);

      // Calculate booking status for this specific segment
      const segmentBookingStatus = getSlotBookingStatus(
        currentStart,
        currentEnd,
        appointmentSlots,
      );

      brokenDownSlots.push({
        ...slot,
        slotId: `${slot.slotOfAvailabilityId}-${currentStart.getTime()}`,
        slotStartTimeInUTC: currentStart.toISOString(),
        slotEndTimeInUTC: currentEnd.toISOString(),
        localStartTime: format(currentStart, "p", { timeZone: timezone }),
        localEndTime: format(currentEnd, "p", { timeZone: timezone }),
        isAllocated: isSegmentAllocated,
        bookingStatus: segmentBookingStatus,
      });

      // Move to next sliding window (30-minute intervals)
      currentStart = new Date(currentStart.getTime() + slidingIntervalMillis);
    }
  });

  // Sort chronologically
  brokenDownSlots.sort(
    (a, b) =>
      new Date(a.slotStartTimeInUTC).getTime() -
      new Date(b.slotStartTimeInUTC).getTime(),
  );

  return brokenDownSlots;
}

/**
 * Group slots by date in the target timezone
 */
export function groupSlotsByDate(
  slotTimings: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[],
  timezone: string,
): Record<
  string,
  (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[]
> {
  const slotsByDate = slotTimings.reduce(
    (acc, slot) => {
      const dateKey = format(
        toZonedTime(new Date(slot.slotStartTimeInUTC), timezone),
        "yyyy-MM-dd",
      );
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(slot);
      return acc;
    },
    {} as Record<
      string,
      (TSlotTiming & {
        isAllocated: boolean;
        bookingStatus: BookingStatus;
      })[]
    >,
  );

  // Sort slots within each day chronologically
  Object.keys(slotsByDate).forEach((dateKey) => {
    slotsByDate[dateKey].sort(
      (a, b) =>
        new Date(a.slotStartTimeInUTC).getTime() -
        new Date(b.slotStartTimeInUTC).getTime(),
    );
  });

  return slotsByDate;
}

/**
 * Main function to process all availability slots with allocation detection
 *
 * @param durationInHours - Duration for breaking down slots (default: 0.5 = 30 minutes)
 *   This ensures each returned slot has its own per-interval booking status
 *   rather than inheriting status from the entire availability block.
 */
export function processAvailabilitySlots(
  weeklySlots: WeeklySlot[],
  customSlots: CustomSlot[],
  appointmentSlots: AppointmentSlot[],
  startDate: Date,
  endDate: Date,
  timezone: string,
  durationInHours: number = 0.5, // Default to 30-minute intervals
): Record<
  string,
  (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[]
> {
  // Process weekly and custom slots
  const processedWeeklySlots = processWeeklySlots(
    weeklySlots,
    startDate,
    endDate,
    timezone,
  );
  const processedCustomSlots = processCustomSlots(
    customSlots,
    startDate,
    endDate,
  );

  // Combine all slots
  const allSlots = [...processedWeeklySlots, ...processedCustomSlots];

  // Split slots that cross midnight
  const splitSlots = splitSlotsByDay(allSlots, timezone);

  // Convert to slot timings with allocation detection
  const slotTimings = convertToSlotTimings(
    splitSlots,
    appointmentSlots,
    timezone,
  );

  // FIX: Break down into smaller intervals (default 30 min) with per-interval booking status
  // This fixes the bug where an 8-hour availability block with 1-hour appointment
  // showed ALL intervals as "Partially Booked" instead of only the booked intervals
  const brokenDownSlots = breakDownSlotsByDuration(
    slotTimings,
    durationInHours,
    appointmentSlots,
    timezone,
  );

  // Group by date
  return groupSlotsByDate(brokenDownSlots, timezone);
}
