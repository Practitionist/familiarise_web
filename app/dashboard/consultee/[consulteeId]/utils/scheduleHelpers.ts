import { EventWithType } from "./getMetadata";
import type { TAppointment, TSlotOfAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";

// Revert getActualSlots to return simple SlotOfAppointment[]
export function getActualSlots(event: EventWithType): SlotOfAppointment[] {
  let appointmentSlots: SlotOfAppointment[] = [];

  switch (event.type) {
    case "Subscription":
    case "Class":
      appointmentSlots = (event.appointments || []).flatMap(
        (apt) => apt?.slotsOfAppointment || [],
      );
      break;
    case "Consultation":
    case "Webinar":
      appointmentSlots = event.appointment?.slotsOfAppointment ?? [];
      break;
    default:
      break;
  }

  const now = new Date(); // Get current time for comparison

  // Filter out past slots and sort
  // Use endsAt instead of startsAt to include ongoing sessions (started but not yet ended)
  // This allows consultees to see and join sessions that have already started
  return appointmentSlots
    .filter(
      (slot) => new Date(slot.endsAt).getTime() >= now.getTime(), // Keep ongoing + future slots
    )
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
}

/**
 * Returns ALL non-tentative slots (past + future) sorted by startsAt asc.
 * Used for displaying the full session schedule in Class/Subscription cards.
 */
export function getAllSlots(event: EventWithType): SlotOfAppointment[] {
  let appointmentSlots: SlotOfAppointment[] = [];

  switch (event.type) {
    case "Subscription":
    case "Class":
      appointmentSlots = (event.appointments || []).flatMap(
        (apt) => apt?.slotsOfAppointment || [],
      );
      break;
    case "Consultation":
    case "Webinar":
      appointmentSlots = event.appointment?.slotsOfAppointment ?? [];
      break;
    default:
      break;
  }

  return appointmentSlots
    .filter((slot) => !slot.isTentative)
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
}

// Revert getActualNextSlotTime to use the simpler getActualSlots
export function getActualNextSlotTime(
  event: EventWithType,
): SlotOfAppointment | null {
  const now = Date.now();
  const slots = getActualSlots(event);
  const futureSlots = slots.filter(
    (slot) => new Date(slot.startsAt).getTime() > now,
  );
  return futureSlots.length > 0 ? futureSlots[0] : null;
}

// getActualUpcomingSlots: Manually transform to the required structure
export function getActualUpcomingSlots(events: EventWithType[]): Array<{
  appointment: TAppointment;
  slot: TSlotOfAppointment;
  isTentative: boolean;
}> {
  const now = new Date();
  const allUpcomingItems: Array<{
    appointment: TAppointment;
    slot: TSlotOfAppointment;
    isTentative: boolean;
  }> = [];

  events.forEach((event) => {
    const slots = getActualSlots(event);
    const futureSlots = slots.filter(
      (slot) => new Date(slot.startsAt).getTime() > now.getTime(),
    );

    futureSlots.forEach((prismaSlot) => {
      // 1. Construct TSlotOfAppointment-compatible slot
      // Note: We cast to TSlotOfAppointment since we're constructing from event data
      const tSlot = {
        id: prismaSlot.id,
        startsAt: new Date(prismaSlot.startsAt),
        endsAt: prismaSlot.endsAt ? new Date(prismaSlot.endsAt) : null,
        isTentative: prismaSlot.isTentative,
        appointmentId: prismaSlot.appointmentId,
        user: (prismaSlot as unknown as { user?: unknown[] }).user || [],
      } as TSlotOfAppointment;

      // 2. Construct TAppointment-compatible appointment
      let baseAppointment: Partial<TAppointment>;
      const upperCaseEventType =
        event.type.toUpperCase() as TAppointment["appointmentType"];

      switch (upperCaseEventType) {
        case "CONSULTATION":
          if (event.type === "Consultation") {
            baseAppointment = {
              id: event.appointment?.id ?? event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              consultation: event as unknown as TAppointment["consultation"],
            };
          } else return; // Use return to exit forEach iteration
          break;
        case "SUBSCRIPTION":
          if (event.type === "Subscription") {
            baseAppointment = {
              id: event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              subscription: event as unknown as TAppointment["subscription"],
            };
          } else return;
          break;
        case "WEBINAR":
          if (event.type === "Webinar") {
            baseAppointment = {
              id: event.appointment?.id ?? event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              webinar: event as unknown as TAppointment["webinar"],
            };
          } else return;
          break;
        case "CLASS":
          if (event.type === "Class") {
            baseAppointment = {
              id: event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              class: event as unknown as TAppointment["class"],
            };
          } else return;
          break;
        default:
          console.warn(`Unknown event type encountered: ${event.type}`);
          return; // Use return to exit forEach iteration
      }

      // baseAppointment is guaranteed to be assigned if we reach here
      const tAppointment = {
        ...baseAppointment,
        slotsOfAppointment: [tSlot],
      } as TAppointment;

      allUpcomingItems.push({
        appointment: tAppointment,
        slot: tSlot,
        isTentative: tSlot.isTentative,
      });
    });
  });

  // Sort the final array
  return allUpcomingItems.sort(
    (a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime(),
  );
}

// Revert getActualMonthlyEvents to use simpler getActualSlots
export function getActualMonthlyEvents(
  events: EventWithType[],
  month: Date,
): Array<{
  event: EventWithType;
  slots: (SlotOfAppointment & { isPast?: boolean; isCancelled?: boolean })[];
}> {
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
    .map((event) => {
      const relevantSlots = getActualSlots(event); // Returns SlotOfAppointment[]

      const monthlySlots = relevantSlots
        .filter(
          (slot) =>
            new Date(slot.startsAt) >= startOfMonth &&
            new Date(slot.startsAt) <= endOfMonth,
        )
        .sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        )
        .map((slot) => ({ ...slot /* Add enrichment flags here if needed */ }));

      return {
        event,
        slots: monthlySlots,
      };
    })
    .filter(({ slots }) => slots.length > 0);
}

// Revert isEventJoinable to use simpler getActualNextSlotTime
export function isEventJoinable(event: EventWithType): boolean {
  const nextSlot = getActualNextSlotTime(event); // Returns SlotOfAppointment | null
  if (!nextSlot || nextSlot.isTentative) return false;

  const now = new Date();
  const diffInMinutes = Math.floor(
    (new Date(nextSlot.startsAt).getTime() - now.getTime()) / 60000,
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
