import { Prisma } from "@prisma/client";
import { TAppointment } from "@/types/appointment";
import { EventWithType } from "../utils";

export interface SlotWithStatus {
  date: Date;
  isTentative: boolean;
  endTime?: Date;
}

interface TentativeSlot {
  startTime: string;
  endTime?: string;
  timezone?: string;
}

export function getActualSlots(event: EventWithType): SlotWithStatus[] {
  // First try to get actual appointment slots
  const appointments = Array.isArray(event.appointment)
    ? event.appointment
    : event.appointment
      ? [event.appointment]
      : [];

  const slots = appointments.flatMap((apt) => apt?.slotsOfAppointment || []);

  const validSlots = slots
    .map(
      (
        slot: Prisma.SlotOfAppointmentGetPayload<{
          include: { user: true };
        }>,
      ) => {
        const startTime = new Date(slot.slotStartTimeInUTC);
        const endTime = new Date(slot.slotEndTimeInUTC);
        return { date: startTime, endTime, isTentative: false };
      },
    )
    .filter((slot: SlotWithStatus) => {
      return slot.date.getFullYear() > 2000;
    });

  // If we have valid appointment slots, return those
  if (validSlots.length > 0) {
    return validSlots.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Otherwise, try to get tentative slots based on event type
  switch (event.type) {
    case "Consultation":
      if (event.preferredDateTime) {
        const preferredDate = new Date(event.preferredDateTime);
        if (preferredDate.getFullYear() > 2000) {
          const endTime = new Date(preferredDate);
          endTime.setHours(endTime.getHours() + 1); // Default 1 hour duration
          return [{ date: preferredDate, endTime, isTentative: true }];
        }
      }
      break;

    case "Subscription":
    case "Class":
      if (event.tentativeSchedule) {
        try {
          const schedule = JSON.parse(
            event.tentativeSchedule,
          ) as TentativeSlot[];
          return schedule
            .map((slot) => {
              const startTime = new Date(slot.startTime);
              const endTime = slot.endTime
                ? new Date(slot.endTime)
                : new Date(startTime.getTime() + 60 * 60 * 1000); // Default 1 hour
              return {
                date: startTime,
                endTime,
                isTentative: true,
              };
            })
            .filter((slot) => slot.date.getFullYear() > 2000)
            .sort((a, b) => a.date.getTime() - b.date.getTime());
        } catch (e) {
          console.error(
            `Error parsing ${event.type.toLowerCase()} tentative schedule:`,
            e,
          );
        }
      }
      break;

    case "Webinar":
      if (event.scheduledAt) {
        const scheduledDate = new Date(event.scheduledAt);
        if (scheduledDate.getFullYear() > 2000) {
          const endTime = new Date(scheduledDate);
          endTime.setHours(endTime.getHours() + 1); // Default 1 hour duration
          return [{ date: scheduledDate, endTime, isTentative: true }];
        }
      }
      break;
  }

  return [];
}

export function getActualNextSlotTime(event: EventWithType): {
  date: Date | null;
  isTentative: boolean;
  endTime?: Date;
} {
  const now = Date.now();
  const slots = getActualSlots(event);
  const futureSlots = slots.filter((slot) => slot.date.getTime() > now);
  return futureSlots.length > 0
    ? {
        date: futureSlots[0].date,
        endTime: futureSlots[0].endTime,
        isTentative: futureSlots[0].isTentative,
      }
    : { date: null, isTentative: false };
}

export function getActualUpcomingSlots(events: EventWithType[]): Array<{
  event: EventWithType;
  slotTime: Date;
  endTime?: Date;
  isTentative: boolean;
}> {
  const now = new Date();
  const allSlots = events.flatMap((event) =>
    getActualSlots(event).map((slot) => ({
      event,
      slotTime: slot.date,
      endTime: slot.endTime,
      isTentative: slot.isTentative,
    })),
  );

  return allSlots
    .filter(({ slotTime }) => slotTime > now)
    .sort((a, b) => a.slotTime.getTime() - b.slotTime.getTime());
}

export function getActualMonthlyEvents(
  events: EventWithType[],
  month: Date,
): Array<{ event: EventWithType; slots: SlotWithStatus[] }> {
  const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const endOfMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
    23,
    59,
    59,
  );

  return events
    .map((event) => ({
      event,
      slots: getActualSlots(event)
        .filter((slot) => slot.date >= startOfMonth && slot.date <= endOfMonth)
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
    }))
    .filter(({ slots }) => slots.length > 0);
}

export function isEventJoinable(event: EventWithType): boolean {
  const slotInfo = getActualNextSlotTime(event);
  if (!slotInfo.date || slotInfo.isTentative) return false;

  const now = new Date();
  const diffInMinutes = Math.floor(
    (slotInfo.date.getTime() - now.getTime()) / 60000,
  );
  return diffInMinutes <= 10 && diffInMinutes > -30;
}

export function formatTimeUntil(minutes: number): string {
  if (minutes <= 0) {
    return "Now";
  }
  if (minutes < 60) {
    return `${minutes} min${minutes !== 1 ? "s" : ""} away`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) {
    if (remainingMins === 0) {
      return `${hours} hr${hours > 1 ? "s" : ""} away`;
    }
    return `${hours} hr${hours > 1 ? "s" : ""} ${remainingMins} min${remainingMins !== 1 ? "s" : ""} away`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} away`;
}
