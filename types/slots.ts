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
};
