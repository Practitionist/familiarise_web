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
  type: "WEEKLY" | "CUSTOM"; // Make type required to distinguish slot source
};

export type TWeeklySlot = {
  id: string;
  dayOfWeekForStartsAt: DayOfWeek;
  availabilityStartsAt: string | Date;
  dayOfWeekForEndsAt: DayOfWeek;
  availabilityEndsAt: string | Date;
};

export type TCustomSlot = {
  id: string;
  availabilityStartsAt: string | Date;
  availabilityEndsAt: string | Date;
};
