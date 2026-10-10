import type {
  ConflictDetail,
  SlotConflictResult,
} from "@/utils/scheduling-engine/types";

type ConflictEntry = SlotConflictResult["conflicts"][number];

/**
 * What a validate route says about a conflicting booking, by viewer. The
 * event's own consultant is a party to every booking on their calendar, so
 * they see the booking id and the other party's name (the grid PR links it);
 * anyone else — an org admin, staff — keeps "Another user", because that
 * booking's content is not theirs (ADR 20).
 */
export function describeConflict(
  slot: string,
  detail: ConflictDetail | undefined,
  viewer: { userId: string; isEventConsultant: boolean },
  fallbackType: string,
): ConflictEntry {
  const time = new Date(slot).toLocaleString();
  if (!detail || !viewer.isEventConsultant) {
    return {
      slot,
      existingAppointment: {
        type: detail?.type ?? fallbackType,
        with: "Another user",
        time,
      },
    };
  }
  const other = detail.otherParty;
  let withWhom = "Another user";
  if (other?.userId === viewer.userId) withWhom = "You (as a consultee)";
  else if (other?.name) withWhom = other.name;
  // A group event has no single other party; its plan title is the name.
  else if (detail.title) withWhom = detail.title;
  return {
    slot,
    existingAppointment: {
      type: detail.type,
      with: withWhom,
      time,
      appointmentId: detail.appointmentId,
    },
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
}): SlotConflictResult & {
  weeklyDistributionErrors: {
    week: string;
    slotsCount: number;
    maxAllowed: number;
  }[];
} {
  const conflicts: SlotConflictResult["conflicts"] = [];
  const outsideAvailability: SlotConflictResult["outsideAvailability"] = [];
  const weeklyDistributionErrors: {
    week: string;
    slotsCount: number;
    maxAllowed: number;
  }[] = [];

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
    } else if (error.startsWith("[WEEKLY_LIMIT]")) {
      const message = error.replace("[WEEKLY_LIMIT] ", "");
      const sessionsMatch = message.match(
        /has (\d+) sessions but max is (\d+)/,
      );
      const weekMatch = message.match(/Week of (.+?) has/);
      if (sessionsMatch && weekMatch) {
        weeklyDistributionErrors.push({
          week: weekMatch[1],
          slotsCount: parseInt(sessionsMatch[1], 10),
          maxAllowed: parseInt(sessionsMatch[2], 10),
        });
      }
    }
  }

  const validSlots = args.slots.filter((bodySlot) => {
    const bodySlotSeconds = new Date(bodySlot).toISOString().slice(0, 19);
    return (
      !conflicts.some((c) => c.slot === bodySlotSeconds) &&
      !outsideAvailability.some((o) => o.slot === bodySlotSeconds)
    );
  });

  return {
    conflicts,
    outsideAvailability,
    validSlots,
    weeklyDistributionErrors,
  };
}
