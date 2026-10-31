import { DayOfWeek } from "@prisma/client";

export type TIntervalTiming = {
  slotId: string;
  dateInISO: string;
  dayOfWeek: DayOfWeek;
  startsAt: string;
  endsAt: string;
  availabilityWindowId: string;
  appointmentOccurrenceId: string;
  localStartTime: string;
  localEndTime: string;
  isAllocated?: boolean;
  allocatedTo?: string;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  type: "WEEKLY" | "CUSTOM"; // Make type required to distinguish slot source
  /** Not yet past, but it starts inside the minimum booking lead time. */
  tooSoon?: boolean;
  /** The subscription's cycle or per-day cap is already full here. */
  limitReached?: boolean;
};

export type TWeeklySlot = {
  id: string;
  startDay: DayOfWeek;
  startTimeUtc: number; // Minutes since midnight UTC (0-1439)
  endDay: DayOfWeek;
  endTimeUtc: number; // Minutes since midnight UTC (0-1439)
};

export type TCustomSlot = {
  id: string;
  startsAt: string | Date;
  endsAt: string | Date;
};
