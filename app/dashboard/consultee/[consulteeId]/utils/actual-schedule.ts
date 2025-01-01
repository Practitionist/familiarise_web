import { PREVIOUS_YEAR } from "@/constants/datetime";
import { EventWithType } from "../utils";

export interface SlotWithStatus {
  date: Date;
  isTentative: boolean;
  endTime?: Date;
}

export function getActualSlots(event: EventWithType): SlotWithStatus[] {
  // Handle appointments based on event type
  const appointments = (() => {
    switch (event.type) {
      case "Subscription":
        return event.appointments || [];
      case "Class":
        return event.appointment || [];
      case "Consultation":
      case "Webinar":
        return event.appointment ? [event.appointment] : [];
      default:
        return [];
    }
  })();

  const slots = appointments.flatMap((apt) => 
    (apt?.slotsOfAppointment || []).map(slot => ({
      date: new Date(slot.slotStartTimeInUTC),
      endTime: new Date(slot.slotEndTimeInUTC),
      isTentative: slot.isTentative
    }))
  );

  return slots
    .filter(slot => slot.date.getFullYear() > PREVIOUS_YEAR)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
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
