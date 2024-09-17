import { Prisma } from '@prisma/client';
import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks
} from 'date-fns';

export type DayOfWeek = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';

export type SlotOfAvailabilityWeekly = Prisma.SlotOfAvailabilityWeeklyGetPayload<{}>;
export type SlotOfAvailabilityCustom = Prisma.SlotOfAvailabilityCustomGetPayload<{}>;
export type SlotOfAvailability = SlotOfAvailabilityWeekly | SlotOfAvailabilityCustom;

export type NewSlot = {
  type: 'weekly' | 'custom';
  dayOfWeekforStartTimeInUTC?: DayOfWeek;
  dayOfWeekforEndTimeInUTC?: DayOfWeek;
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
};

export const navigateCalendar = (currentDate: Date, view: 'week' | 'month', direction: 'prev' | 'next'): Date => {
  if (view === 'week') {
    return direction === 'prev' ? subWeeks(currentDate, 1) : addWeeks(currentDate, 1);
  } else {
    return direction === 'prev' ? subMonths(currentDate, 1) : addMonths(currentDate, 1);
  }
};

export const getWeekDays = (currentDate: Date) => {
  const startDate = startOfWeek(currentDate);
  const endDate = endOfWeek(currentDate);
  return eachDayOfInterval({ start: startDate, end: endDate });
};

export const getMonthDays = (currentDate: Date) => {
  const startDate = startOfMonth(currentDate);
  const endDate = endOfMonth(currentDate);
  return eachDayOfInterval({ start: startDate, end: endDate });
};

export const filterSlotsByDay = (slots: SlotOfAvailability[], day: Date, currentDate: Date) => {
  return slots.filter(slot => {
    const slotDate = 'dayOfWeekforStartTimeInUTC' in slot
      ? addDays(startOfWeek(currentDate), ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].indexOf(slot.dayOfWeekforStartTimeInUTC))
      : new Date(slot.slotStartTimeInUTC);
    return isSameDay(slotDate, day);
  });
};

export const formatSlotTime = (slot: SlotOfAvailability) => {
  const startTime = 'dayOfWeekforStartTimeInUTC' in slot
    ? new Date(slot.slotStartTimeInUTC)
    : new Date(slot.slotStartTimeInUTC);
  const endTime = 'dayOfWeekforEndTimeInUTC' in slot
    ? new Date(slot.slotEndTimeInUTC)
    : new Date(slot.slotEndTimeInUTC);
  return `${format(startTime, 'HH:mm')} - ${format(endTime, 'HH:mm')}`;
};

export const calculateSlotPosition = (slot: SlotOfAvailability) => {
  const startTime = 'dayOfWeekforStartTimeInUTC' in slot
    ? new Date(slot.slotStartTimeInUTC)
    : new Date(slot.slotStartTimeInUTC);
  const endTime = 'dayOfWeekforEndTimeInUTC' in slot
    ? new Date(slot.slotEndTimeInUTC)
    : new Date(slot.slotEndTimeInUTC);
  const startMinutes = startTime.getHours() * 60 + startTime.getMinutes();
  const endMinutes = endTime.getHours() * 60 + endTime.getMinutes();
  const duration = endMinutes - startMinutes;
  return {
    top: `${startMinutes / 60 * 3}rem`,
    height: `${duration / 60 * 3}rem`,
  };
};