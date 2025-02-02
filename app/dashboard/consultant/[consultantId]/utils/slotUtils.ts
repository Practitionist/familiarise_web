import { startOfWeek, addDays, parse, format } from "date-fns";

interface WeeklySlot {
  id: string;
  dayOfWeekforStartTimeInUTC: string;
  slotStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: string;
  slotEndTimeInUTC: string;
}

const DAYS_OF_WEEK = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export function convertWeeklyToActualSlots(
  weeklySlots: WeeklySlot[],
  baseDate: Date = new Date(),
) {
  // Get the start of the week for the base date
  const weekStart = startOfWeek(baseDate);

  return weeklySlots.flatMap((slot) => {
    // Get the day number (0-6) for this slot
    const dayNumber =
      DAYS_OF_WEEK[
        slot.dayOfWeekforStartTimeInUTC as keyof typeof DAYS_OF_WEEK
      ];
    if (dayNumber === undefined) return [];

    // Get the actual date for this slot
    const slotDate = addDays(weekStart, dayNumber);

    // Parse the time from the 1970 timestamp
    const timeOnly = format(new Date(slot.slotStartTimeInUTC), "HH:mm:ss");

    // Combine the date and time
    const actualSlotTime = parse(
      `${format(slotDate, "yyyy-MM-dd")} ${timeOnly}`,
      "yyyy-MM-dd HH:mm:ss",
      new Date(),
    );

    return {
      id: slot.id,
      slotStartTimeInUTC: actualSlotTime.toISOString(),
      slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC).toISOString(),
    };
  });
}
