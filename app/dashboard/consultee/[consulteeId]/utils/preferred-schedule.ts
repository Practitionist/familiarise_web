import { EventWithType } from "../utils";

interface SlotInfo {
  startTime: string;
  endTime: string;
  timezone: string;
}

export function getPreferredSlots(event: EventWithType): Date[] {
  switch (event.type) {
    case "Consultation":
      return event.preferredDateTime ? [new Date(event.preferredDateTime)] : [];
    case "Subscription":
      try {
        const schedule: SlotInfo[] = event.tentativeSchedule
          ? JSON.parse(event.tentativeSchedule)
          : [];
        return schedule.map((slot) => new Date(slot.startTime));
      } catch (e) {
        console.error("Error parsing subscription schedule:", e);
        return [];
      }
    case "Class":
      try {
        const schedule: SlotInfo[] = event.tentativeSchedule
          ? JSON.parse(event.tentativeSchedule)
          : [];
        return schedule.map((slot) => new Date(slot.startTime));
      } catch (e) {
        console.error("Error parsing class schedule:", e);
        return [];
      }
    case "Webinar":
      return event.scheduledAt ? [new Date(event.scheduledAt)] : [];
    default:
      return [];
  }
}

export function getPreferredNextSlotTime(event: EventWithType): Date {
  const now = Date.now();
  const slots = getPreferredSlots(event);
  const futureSlots = slots.filter((slot) => slot.getTime() > now);
  return futureSlots.length > 0 ? futureSlots[0] : new Date(now);
}

export function getPreferredUpcomingSlots(
  events: EventWithType[],
): Array<{ event: EventWithType; slotTime: Date }> {
  const now = new Date();
  const allSlots = events.flatMap((event) =>
    getPreferredSlots(event).map((slotTime) => ({
      event,
      slotTime,
    })),
  );

  return allSlots
    .filter(({ slotTime }) => slotTime > now)
    .sort((a, b) => a.slotTime.getTime() - b.slotTime.getTime());
}

export function getPreferredMonthlyEvents(
  events: EventWithType[],
  month: Date,
): Array<{ event: EventWithType; slots: Date[] }> {
  const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);

  return events
    .map((event) => ({
      event,
      slots: getPreferredSlots(event).filter(
        (slot) => slot >= startOfMonth && slot <= endOfMonth,
      ),
    }))
    .filter(({ slots }) => slots.length > 0);
}
