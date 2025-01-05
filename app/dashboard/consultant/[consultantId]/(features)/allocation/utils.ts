export type DayOfWeek =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export interface NewSlot {
  type: "weekly" | "custom";
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
}

export interface Slot {
  id: string;
  type: "weekly" | "custom";
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
  isBooked: boolean;
}

export const DAYS_OF_WEEK: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

export const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function getTimeString(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function getDayString(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function getMonthString(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function getWeekDates(date: Date): Date[] {
  const sunday = new Date(date);
  sunday.setDate(date.getDate() - date.getDay());

  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(sunday);
    day.setDate(sunday.getDate() + i);
    return day;
  });
}

export function getMonthDates(date: Date): Date[] {
  const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);

  // Get the first Sunday before or on the first day of the month
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - firstDay.getDay());

  // Get the last Saturday after or on the last day of the month
  const endDate = new Date(lastDay);
  endDate.setDate(lastDay.getDate() + (6 - lastDay.getDay()));

  const days: Date[] = [];
  const currentDate = new Date(startDate);

  while (currentDate <= endDate) {
    days.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return days;
}

export function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

export function isInMonth(date: Date, monthDate: Date): boolean {
  return (
    date.getFullYear() === monthDate.getFullYear() &&
    date.getMonth() === monthDate.getMonth()
  );
}

export function getSlotStyle(slot: Slot): string {
  if (slot.isBooked) {
    return "bg-gray-200 text-gray-500 cursor-not-allowed";
  }
  return "bg-blue-100 text-blue-600 hover:bg-blue-200 cursor-pointer";
}
