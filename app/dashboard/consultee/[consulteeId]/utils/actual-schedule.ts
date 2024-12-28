import { Prisma } from "@prisma/client";
import { TAppointment } from "@/types/appointment";
import { EventWithType } from "../utils";

export interface SlotWithStatus {
  date: Date;
  isTentative: boolean;
}

export function getActualSlots(event: EventWithType): SlotWithStatus[] {
  // Use the actual appointment slots from slotOfAppointment
  // Handle both single appointment and array of appointments
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
        // Convert UTC time to browser's timezone
        const startTime = new Date(slot.slotStartTimeInUTC);
        return { date: startTime, isTentative: false };
      },
    )
    .filter((slot: SlotWithStatus) => {
      // Filter out invalid dates (like 1970)
      return slot.date.getFullYear() > 2000;
    });

  // If no valid slots found, use fallback times based on event type
  if (validSlots.length === 0) {
    switch (event.type) {
      case "Consultation":
        if (event.preferredDateTime) {
          const preferredDate = new Date(event.preferredDateTime);
          if (preferredDate.getFullYear() > 2000) {
            return [{ date: preferredDate, isTentative: true }];
          }
        }
        break;

      case "Subscription":
        if (event.tentativeSchedule) {
          try {
            const schedule = JSON.parse(event.tentativeSchedule);
            return schedule
              .map((slot: { startTime: string }) => ({
                date: new Date(slot.startTime),
                isTentative: true,
              }))
              .filter((slot: SlotWithStatus) => slot.date.getFullYear() > 2000);
          } catch (e) {
            console.error("Error parsing subscription tentative schedule:", e);
          }
        }
        break;

      case "Class":
        if (event.tentativeSchedule) {
          try {
            const schedule = JSON.parse(event.tentativeSchedule);
            return schedule
              .map((slot: { startTime: string }) => ({
                date: new Date(slot.startTime),
                isTentative: true,
              }))
              .filter((slot: SlotWithStatus) => slot.date.getFullYear() > 2000);
          } catch (e) {
            console.error("Error parsing class tentative schedule:", e);
          }
        }
        break;

      case "Webinar":
        if (event.scheduledAt) {
          const scheduledDate = new Date(event.scheduledAt);
          if (scheduledDate.getFullYear() > 2000) {
            return [{ date: scheduledDate, isTentative: true }];
          }
        }
        break;
    }
  }

  return validSlots;
}

export function getActualNextSlotTime(event: EventWithType): {
  date: Date | null;
  isTentative: boolean;
} {
  const now = Date.now();
  const slots = getActualSlots(event);
  const futureSlots = slots.filter((slot) => slot.date.getTime() > now);
  return futureSlots.length > 0
    ? { date: futureSlots[0].date, isTentative: futureSlots[0].isTentative }
    : { date: null, isTentative: false };
}

export function getActualUpcomingSlots(
  events: EventWithType[],
): Array<{ event: EventWithType; slotTime: Date; isTentative: boolean }> {
  const now = new Date();
  const allSlots = events.flatMap((event) =>
    getActualSlots(event).map((slot) => ({
      event,
      slotTime: slot.date,
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
  const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);

  return events
    .map((event) => ({
      event,
      slots: getActualSlots(event).filter(
        (slot) => slot.date >= startOfMonth && slot.date <= endOfMonth,
      ),
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
