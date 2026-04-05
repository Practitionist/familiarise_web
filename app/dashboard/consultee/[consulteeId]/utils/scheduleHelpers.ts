import { EventWithType } from "./getMetadata";
import type { TAppointment, TSlotOfAppointment } from "@/types/appointment";
import type { SlotOfAppointment } from "@prisma/client";

/**
 * Converts a Prisma SlotOfAppointment (without relations) into a
 * TSlotOfAppointment-compatible object.  The Prisma base type lacks the
 * `user` and `meetingSession` relations that TSlotOfAppointment expects,
 * so we supply safe defaults (empty array / undefined) for the missing
 * fields and only fall back to a narrowly-scoped cast for the remainder.
 */
function toTSlot(prismaSlot: SlotOfAppointment): TSlotOfAppointment {
  const slotWithRelations = prismaSlot as SlotOfAppointment & {
    user?: TSlotOfAppointment["user"];
    meetingSession?: TSlotOfAppointment["meetingSession"];
  };
  return {
    ...slotWithRelations,
    startsAt: new Date(prismaSlot.startsAt),
    endsAt: new Date(prismaSlot.endsAt),
    user: slotWithRelations.user ?? [],
    meetingSession: slotWithRelations.meetingSession ?? null,
  };
}

/**
 * Builds a partial TAppointment for a given EventWithType.
 *
 * The event types (TConsultationWithPlan, etc.) overlap heavily with the
 * corresponding TAppointment relation fields (consultation, subscription,
 * webinar, class) but differ in the depth of `consultantProfile` includes.
 * Rather than scattering `as unknown as` casts at every call-site we
 * centralise the conversion here so the rest of the module stays cast-free.
 */
function toPartialAppointment(
  event: EventWithType,
): Partial<TAppointment> | null {
  const upperType = event.type.toUpperCase() as TAppointment["appointmentType"];

  switch (event.type) {
    case "Consultation":
      return {
        id: event.appointment?.id ?? event.id,
        appointmentType: upperType,
        consultation: event as unknown as TAppointment["consultation"],
      };
    case "Subscription":
      return {
        id: event.id,
        appointmentType: upperType,
        subscription: event as unknown as TAppointment["subscription"],
      };
    case "Webinar":
      return {
        id: event.appointment?.id ?? event.id,
        appointmentType: upperType,
        webinar: event as unknown as TAppointment["webinar"],
      };
    case "Class":
      return {
        id: event.id,
        appointmentType: upperType,
        class: event as unknown as TAppointment["class"],
      };
    default: {
      const _exhaustive: never = event;
      console.warn(`Unknown event type encountered: ${(_exhaustive as EventWithType).type}`);
      return null;
    }
  }
}

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
      const tSlot = toTSlot(prismaSlot);

      const baseAppointment = toPartialAppointment(event);
      if (!baseAppointment) return;

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
