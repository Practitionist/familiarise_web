import { DayOfWeek } from "@prisma/client";

export type TSlotTiming = {
  slotId: string;
  dateInISO: string;
  dayOfWeek: DayOfWeek;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  slotOfAvailabilityId: string;
  slotOfAppointmentId: string;
  localStartTime: string;
  localEndTime: string;
  isAllocated?: boolean;
  allocatedTo?: string;
  type?: "WEEKLY" | "CUSTOM";
};

export type TWeeklySlot = {
  id: string;
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: string | Date;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotEndTimeInUTC: string | Date;
};

export type TCustomSlot = {
  id: string;
  slotStartTimeInUTC: string | Date;
  slotEndTimeInUTC: string | Date;
};
