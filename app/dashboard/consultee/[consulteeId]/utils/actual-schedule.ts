import { EventWithType } from "../utils";
// Import the specific types needed
import type {
  IAppointment,
  ISlotOfAppointment,
} from "@/app/dashboard/consultant/[consultantId]/types";
import type { SlotOfAppointment } from "@prisma/client"; // Import Prisma types

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
  return appointmentSlots
    .filter(
      (slot) => new Date(slot.slotStartTimeInUTC).getTime() >= now.getTime(), // Keep only future or current slots
      // && new Date(slot.slotStartTimeInUTC).getFullYear() > PREVIOUS_YEAR // Removed year filter
    )
    .sort(
      (a, b) =>
        new Date(a.slotStartTimeInUTC).getTime() -
        new Date(b.slotStartTimeInUTC).getTime(),
    );
}

// Revert getActualNextSlotTime to use the simpler getActualSlots
export function getActualNextSlotTime(
  event: EventWithType,
): SlotOfAppointment | null {
  const now = Date.now();
  const slots = getActualSlots(event);
  const futureSlots = slots.filter(
    (slot) => new Date(slot.slotStartTimeInUTC).getTime() > now,
  );
  return futureSlots.length > 0 ? futureSlots[0] : null;
}

// getActualUpcomingSlots: Manually transform to the required structure
export function getActualUpcomingSlots(events: EventWithType[]): Array<{
  appointment: IAppointment;
  slot: ISlotOfAppointment;
  isTentative: boolean;
}> {
  const now = new Date();
  const allUpcomingItems: Array<{
    appointment: IAppointment;
    slot: ISlotOfAppointment;
    isTentative: boolean;
  }> = [];

  events.forEach((event) => {
    const slots = getActualSlots(event);
    const futureSlots = slots.filter(
      (slot) => new Date(slot.slotStartTimeInUTC).getTime() > now.getTime(),
    );

    futureSlots.forEach((prismaSlot) => {
      // 1. Construct ISlotOfAppointment
      const iSlot: ISlotOfAppointment = {
        id: prismaSlot.id,
        slotStartTimeInUTC: new Date(prismaSlot.slotStartTimeInUTC),
        slotEndTimeInUTC: prismaSlot.slotEndTimeInUTC
          ? new Date(prismaSlot.slotEndTimeInUTC)
          : null,
        isTentative: prismaSlot.isTentative,
        // Explicitly set user to empty array as relation is likely missing
        // TODO: Ensure user relation is included in upstream fetch if needed
        user: [],
        // user: ((prismaSlot as any).user || []).map((u: User) => ({ ... })), // Original attempt
      };

      // 2. Construct IAppointment
      let baseAppointment: Omit<IAppointment, "slotsOfAppointment">;
      const upperCaseEventType =
        event.type.toUpperCase() as IAppointment["appointmentType"];

      switch (upperCaseEventType) {
        case "CONSULTATION":
          if (event.type === "Consultation") {
            baseAppointment = {
              id: event.appointment?.id ?? event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              consultation: event as any,
            };
          } else return; // Use return to exit forEach iteration
          break;
        case "SUBSCRIPTION":
          if (event.type === "Subscription") {
            baseAppointment = {
              id: event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              subscription: event as any,
            };
          } else return;
          break;
        case "WEBINAR":
          if (event.type === "Webinar") {
            baseAppointment = {
              id: event.appointment?.id ?? event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              webinar: event as any,
            };
          } else return;
          break;
        case "CLASS":
          if (event.type === "Class") {
            baseAppointment = {
              id: event.id,
              appointmentType: upperCaseEventType,
              // WARNING: Unsafe cast due to structural mismatch (consultantProfile)
              class: event as any,
            };
          } else return;
          break;
        default:
          console.warn(`Unknown event type encountered: ${event.type}`);
          return; // Use return to exit forEach iteration
      }

      // baseAppointment is guaranteed to be assigned if we reach here
      const iAppointment: IAppointment = {
        ...baseAppointment,
        slotsOfAppointment: [iSlot],
      };

      allUpcomingItems.push({
        appointment: iAppointment,
        slot: iSlot,
        isTentative: iSlot.isTentative,
      });
    });
  });

  // Sort the final array
  return allUpcomingItems.sort(
    (a, b) =>
      a.slot.slotStartTimeInUTC.getTime() - b.slot.slotStartTimeInUTC.getTime(),
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
            new Date(slot.slotStartTimeInUTC) >= startOfMonth &&
            new Date(slot.slotStartTimeInUTC) <= endOfMonth,
        )
        .sort(
          (a, b) =>
            new Date(a.slotStartTimeInUTC).getTime() -
            new Date(b.slotStartTimeInUTC).getTime(),
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
    (new Date(nextSlot.slotStartTimeInUTC).getTime() - now.getTime()) / 60000,
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
