import type {
  ConflictDetail,
  SlotConflictResult,
} from "@/utils/scheduling-engine/types";

type ConflictEntry = SlotConflictResult["conflicts"][number];

/** Who is busy at a conflicting time, as a validate route reports it. */
export const CONFLICT_WITH = {
  /** The viewing consultant's own booking. */
  you: "you",
  /** The client already has a session elsewhere. */
  client: "your client",
  /** Any other viewer: a time, never a party. */
  other: "another booking",
} as const;

/**
 * What a validate route says about a conflicting booking: the time, never
 * whose booking it is. The event's own consultant learns whether the clash is
 * on their calendar (and gets the link to their own booking) or their client's;
 * anyone else (an org admin, staff) only that the time is booked.
 */
export function describeConflict(
  slot: string,
  detail: ConflictDetail | undefined,
  viewer: { userId: string; isEventConsultant: boolean },
  fallbackType: string,
): ConflictEntry {
  const time = `${slot}Z`;
  if (!detail || !viewer.isEventConsultant) {
    return {
      slot,
      existingAppointment: {
        type: "Booking",
        with: CONFLICT_WITH.other,
        time,
      },
    };
  }
  if (detail.onConsultantCalendar) {
    return {
      slot,
      existingAppointment: {
        type: detail.type ?? fallbackType,
        with: CONFLICT_WITH.you,
        time,
        appointmentId: detail.appointmentId,
      },
    };
  }
  return {
    slot,
    existingAppointment: { type: "Booking", with: CONFLICT_WITH.client, time },
  };
}

/** Index the validator's structured conflicts by their seconds-precision slot. */
export function conflictDetailsBySlot(
  details: ConflictDetail[] | undefined,
): Map<string, ConflictDetail> {
  return new Map((details ?? []).map((d) => [d.slot, d]));
}

import type prisma from "@/lib/prisma";

export async function findTentativeOccurrenceIdsForEvent(
  db: {
    appointment?: Partial<Pick<(typeof prisma)["appointment"], "findMany">>;
  },
  where:
    { webinarId: string } | { classId: string } | { subscriptionId: string },
): Promise<string[]> {
  const rows =
    (await db.appointment?.findMany?.({
      where: {
        ...where,
        occurrences: { some: { isTentative: true, deletedAt: null } },
      },
      select: {
        id: true,
        occurrences: {
          where: { isTentative: true, deletedAt: null },
          select: { id: true },
        },
      },
    })) ?? [];
  return rows.flatMap((a) => (a.occurrences ?? []).map((o) => o.id));
}

export function categorizeValidationErrors(args: {
  errors: string[];
  slots: string[];
  conflictDetails: Map<string, ConflictDetail>;
  viewer: { userId: string; isEventConsultant: boolean };
  resolveFallbackType: (message: string) => string;
}): SlotConflictResult {
  const conflicts: SlotConflictResult["conflicts"] = [];
  const outsideAvailability: SlotConflictResult["outsideAvailability"] = [];
  const tooSoon: NonNullable<SlotConflictResult["tooSoon"]> = [];
  // A finding no bucket can pin to a slot (e.g. sessions not consecutive)
  // refuses the whole set: nothing is reported valid then.
  let unplaced = false;

  for (const error of args.errors) {
    if (error.startsWith("[CONFLICT]")) {
      const message = error.replace("[CONFLICT] ", "");
      const slotMatch = message.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (slotMatch) {
        conflicts.push(
          describeConflict(
            slotMatch[1],
            args.conflictDetails.get(slotMatch[1]),
            args.viewer,
            args.resolveFallbackType(message),
          ),
        );
      }
    } else if (error.startsWith("[OUTSIDE_AVAILABILITY]")) {
      const message = error.replace("[OUTSIDE_AVAILABILITY] ", "");
      const slotMatch = message.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
      if (slotMatch) {
        outsideAvailability.push({ slot: slotMatch[1] });
      } else {
        for (const bodySlot of args.slots) {
          const normalized = new Date(bodySlot).toISOString().slice(0, 19);
          if (!outsideAvailability.some((o) => o.slot === normalized)) {
            outsideAvailability.push({ slot: normalized });
          }
        }
      }
    } else if (error.startsWith("[TOO_SOON]")) {
      for (const match of error.matchAll(
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/g,
      )) {
        tooSoon.push({ slot: match[1] });
      }
    } else {
      unplaced = true;
    }
  }

  const validSlots = unplaced
    ? []
    : args.slots.filter((bodySlot) => {
        const bodySlotSeconds = new Date(bodySlot).toISOString().slice(0, 19);
        return (
          !conflicts.some((c) => c.slot === bodySlotSeconds) &&
          !outsideAvailability.some((o) => o.slot === bodySlotSeconds) &&
          !tooSoon.some((t) => t.slot === bodySlotSeconds)
        );
      });

  return {
    conflicts,
    outsideAvailability,
    tooSoon,
    validSlots,
  };
}
